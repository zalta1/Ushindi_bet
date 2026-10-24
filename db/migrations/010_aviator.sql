-- Aviator: one global round, ledger bets, and provably fair seeds.
-- Crash points are written when the round opens and never change in flight.
-- Players see the server-seed hash immediately. The seed and crash point
-- stay on the row, and the API hides them until the round has crashed or aborted.

CREATE SEQUENCE aviator_round_no_seq;

CREATE TABLE aviator_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_no BIGINT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('betting', 'flying', 'crashed', 'aborted')),
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce BIGINT NOT NULL,
  crash_hash TEXT NOT NULL,
  crash_point NUMERIC(12, 2) NOT NULL CHECK (crash_point >= 1),
  rtp_bps INT NOT NULL,
  max_multiplier NUMERIC(12, 2) NOT NULL,
  max_win_tzs BIGINT NOT NULL,
  betting_ms INT NOT NULL,
  betting_ends_at TIMESTAMPTZ NOT NULL,
  flying_started_at TIMESTAMPTZ,
  crashed_at TIMESTAMPTZ,
  aborted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE aviator_state (
  id INT PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('idle', 'betting', 'flying', 'crashed')),
  round_id UUID REFERENCES aviator_rounds (id) ON DELETE SET NULL,
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO aviator_state (id, phase, round_id, phase_started_at)
VALUES (1, 'idle', NULL, '2000-01-01');

CREATE TABLE aviator_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  round_id UUID NOT NULL REFERENCES aviator_rounds (id),
  panel SMALLINT NOT NULL CHECK (panel IN (1, 2)),
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  auto_cashout_at NUMERIC(12, 2),
  status TEXT NOT NULL CHECK (status IN ('active', 'cashed_out', 'lost', 'refunded')),
  cashout_multiplier NUMERIC(12, 2),
  payout_tzs BIGINT NOT NULL DEFAULT 0 CHECK (payout_tzs >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (user_id, round_id, panel)
);

CREATE INDEX aviator_bets_round_idx ON aviator_bets (round_id, created_at);
CREATE INDEX aviator_bets_winners_idx ON aviator_bets (status, settled_at);

CREATE TABLE aviator_chat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users (id)
);

CREATE INDEX aviator_chat_created_idx ON aviator_chat (created_at DESC);

CREATE TABLE aviator_mutes (
  user_id UUID PRIMARY KEY REFERENCES users (id),
  until_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE aviator_viewers (
  user_id UUID NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  last_ping TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

-- Piecewise curve from the PesaBetPro engine (the code, not the comment above it):
-- 0.07 until 1.50x, 0.07 until 2.00x, 0.08 until 10x, then 0.09.
-- Returned value is floored to 2 decimal places. 0 seconds is 1.00x.
CREATE OR REPLACE FUNCTION aviator_multiplier(p_seconds DOUBLE PRECISION)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  m DOUBLE PRECISION := 1.0;
  remaining DOUBLE PRECISION := GREATEST(COALESCE(p_seconds, 0), 0);
  maxs DOUBLE PRECISION[] := ARRAY[1.50, 2.00, 10.00, 1000000000];
  ks DOUBLE PRECISION[] := ARRAY[0.07, 0.07, 0.08, 0.09];
  i INT;
  dt DOUBLE PRECISION;
BEGIN
  IF remaining <= 0 THEN
    RETURN 1.00;
  END IF;
  FOR i IN 1..4 LOOP
    dt := ln(maxs[i] / m) / ks[i];
    IF remaining <= dt OR i = 4 THEN
      m := m * exp(ks[i] * LEAST(remaining, dt));
      EXIT;
    END IF;
    remaining := remaining - dt;
    m := maxs[i];
  END LOOP;
  IF m < 1 THEN
    m := 1;
  END IF;
  RETURN floor(m * 100)::numeric / 100;
END;
$$;

CREATE OR REPLACE FUNCTION place_aviator_bet_atomic(
  p_user_id UUID,
  p_round_id UUID,
  p_panel INT,
  p_amount BIGINT,
  p_auto NUMERIC,
  p_idempotency_key TEXT,
  p_min_stake BIGINT,
  p_max_stake BIGINT,
  p_enabled BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing aviator_bets%ROWTYPE;
  v_phase TEXT;
  v_state_round UUID;
  v_ends TIMESTAMPTZ;
  v_max_mult NUMERIC;
  v_bet_id UUID;
  v_ledger JSONB;
  v_balance BIGINT;
BEGIN
  PERFORM assert_idempotency_key(p_idempotency_key);
  IF p_panel NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount < p_min_stake OR p_amount > p_max_stake THEN
    RAISE EXCEPTION 'invalid_stake' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM aviator_bets WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.panel <> p_panel OR v_existing.stake_tzs <> p_amount THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT balance_tzs INTO v_balance FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'idempotent', true,
      'bet_id', v_existing.id,
      'balance_tzs', v_balance,
      'stake_tzs', v_existing.stake_tzs,
      'panel', v_existing.panel
    );
  END IF;

  IF NOT p_enabled THEN
    RAISE EXCEPTION 'game_disabled' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.phase, s.round_id, r.betting_ends_at, r.max_multiplier
    INTO v_phase, v_state_round, v_ends, v_max_mult
    FROM aviator_state s
    JOIN aviator_rounds r ON r.id = s.round_id
   WHERE s.id = 1
   FOR UPDATE OF s;

  IF v_phase IS DISTINCT FROM 'betting' OR v_state_round IS DISTINCT FROM p_round_id
     OR v_ends IS NULL OR clock_timestamp() >= v_ends THEN
    RAISE EXCEPTION 'betting_closed' USING ERRCODE = 'P0001';
  END IF;

  IF p_auto IS NOT NULL AND (p_auto < 1.01 OR p_auto > v_max_mult) THEN
    RAISE EXCEPTION 'invalid_auto' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM aviator_rounds WHERE id = p_round_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM aviator_bets
     WHERE user_id = p_user_id AND round_id = p_round_id AND panel = p_panel
  ) THEN
    RAISE EXCEPTION 'already_placed' USING ERRCODE = 'P0001';
  END IF;

  v_bet_id := gen_random_uuid();
  v_ledger := wallet_debit(
    p_user_id, p_amount, 'bet_stake', p_idempotency_key, 'cash',
    'aviator_bet', v_bet_id, 'aviator', p_round_id::text
  );

  BEGIN
    INSERT INTO aviator_bets (
      id, user_id, round_id, panel, stake_tzs, auto_cashout_at, status, idempotency_key
    ) VALUES (
      v_bet_id, p_user_id, p_round_id, p_panel, p_amount, p_auto, 'active', p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already_placed' USING ERRCODE = 'P0001';
  END;

  RETURN jsonb_build_object(
    'idempotent', false,
    'bet_id', v_bet_id,
    'balance_tzs', v_ledger->'balance_tzs',
    'stake_tzs', p_amount,
    'panel', p_panel
  );
END;
$$;

-- Cash out at the multiplier implied by the database clock and flying_started_at.
-- A client-supplied multiplier is never accepted. Paying twice is a no-op.
CREATE OR REPLACE FUNCTION cashout_aviator_bet_atomic(
  p_user_id UUID,
  p_bet_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bet aviator_bets%ROWTYPE;
  v_round aviator_rounds%ROWTYPE;
  v_mult NUMERIC;
  v_payout BIGINT;
  v_ledger JSONB;
  v_balance BIGINT;
BEGIN
  SELECT * INTO v_bet FROM aviator_bets WHERE id = p_bet_id;
  IF NOT FOUND OR v_bet.user_id <> p_user_id THEN
    RAISE EXCEPTION 'bet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_round FROM aviator_rounds WHERE id = v_bet.round_id FOR UPDATE;
  SELECT * INTO v_bet FROM aviator_bets WHERE id = p_bet_id FOR UPDATE;

  IF v_bet.status = 'cashed_out' THEN
    SELECT balance_tzs INTO v_balance FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'idempotent', true,
      'bet_id', v_bet.id,
      'multiplier', v_bet.cashout_multiplier,
      'payout_tzs', v_bet.payout_tzs,
      'balance_tzs', v_balance
    );
  END IF;
  IF v_bet.status <> 'active' THEN
    RAISE EXCEPTION 'bet_closed' USING ERRCODE = 'P0001';
  END IF;
  IF v_round.status IS DISTINCT FROM 'flying' OR v_round.flying_started_at IS NULL THEN
    IF v_round.status = 'crashed' THEN
      RAISE EXCEPTION 'crashed' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'not_flying' USING ERRCODE = 'P0001';
  END IF;

  v_mult := aviator_multiplier(EXTRACT(EPOCH FROM (clock_timestamp() - v_round.flying_started_at)));
  IF v_mult >= v_round.crash_point THEN
    RAISE EXCEPTION 'crashed' USING ERRCODE = 'P0001';
  END IF;
  IF v_mult < 1.01 THEN
    RAISE EXCEPTION 'too_early' USING ERRCODE = 'P0001';
  END IF;

  v_payout := LEAST(floor(v_bet.stake_tzs * v_mult)::bigint, v_round.max_win_tzs);
  IF v_payout <= 0 THEN
    RAISE EXCEPTION 'too_early' USING ERRCODE = 'P0001';
  END IF;

  UPDATE aviator_bets
     SET status = 'cashed_out',
         cashout_multiplier = v_mult,
         payout_tzs = v_payout,
         settled_at = clock_timestamp()
   WHERE id = v_bet.id;

  v_ledger := wallet_credit(
    p_user_id, v_payout, 'bet_win', 'aviator-win-' || v_bet.id::text, 'cash',
    'aviator_bet', v_bet.id, 'aviator', NULL
  );

  RETURN jsonb_build_object(
    'idempotent', COALESCE((v_ledger->>'idempotent')::boolean, false),
    'bet_id', v_bet.id,
    'multiplier', v_mult,
    'payout_tzs', v_payout,
    'balance_tzs', v_ledger->'balance_tzs'
  );
END;
$$;

-- Auto cash out pays the target multiplier, not whatever the plane has reached since.
CREATE OR REPLACE FUNCTION aviator_auto_cashout(p_round_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round aviator_rounds%ROWTYPE;
  v_bet aviator_bets%ROWTYPE;
  v_live NUMERIC;
  v_payout BIGINT;
  v_count INT := 0;
BEGIN
  SELECT * INTO v_round FROM aviator_rounds WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND OR v_round.status IS DISTINCT FROM 'flying' OR v_round.flying_started_at IS NULL THEN
    RETURN 0;
  END IF;
  v_live := aviator_multiplier(EXTRACT(EPOCH FROM (clock_timestamp() - v_round.flying_started_at)));

  FOR v_bet IN
    SELECT * FROM aviator_bets
     WHERE round_id = p_round_id
       AND status = 'active'
       AND auto_cashout_at IS NOT NULL
       AND auto_cashout_at >= 1.01
       AND auto_cashout_at < v_round.crash_point
       AND v_live >= auto_cashout_at
     ORDER BY id
     FOR UPDATE
  LOOP
    v_payout := LEAST(floor(v_bet.stake_tzs * v_bet.auto_cashout_at)::bigint, v_round.max_win_tzs);
    IF v_payout <= 0 THEN
      CONTINUE;
    END IF;
    UPDATE aviator_bets
       SET status = 'cashed_out',
           cashout_multiplier = v_bet.auto_cashout_at,
           payout_tzs = v_payout,
           settled_at = clock_timestamp()
     WHERE id = v_bet.id AND status = 'active';
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    PERFORM wallet_credit(
      v_bet.user_id, v_payout, 'bet_win', 'aviator-win-' || v_bet.id::text, 'cash',
      'aviator_bet', v_bet.id, 'aviator', NULL
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Refund every still-active bet on a betting or flying round. Crashed rounds are left alone.
-- Replaying this does not credit the wallet twice.
CREATE OR REPLACE FUNCTION refund_aviator_round(p_round_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round aviator_rounds%ROWTYPE;
  v_bet aviator_bets%ROWTYPE;
  v_count INT := 0;
BEGIN
  SELECT * INTO v_round FROM aviator_rounds WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('refunded', 0, 'status', 'missing');
  END IF;
  IF v_round.status = 'crashed' THEN
    RETURN jsonb_build_object('refunded', 0, 'status', 'crashed');
  END IF;
  IF v_round.status IN ('betting', 'flying') THEN
    UPDATE aviator_rounds
       SET status = 'aborted', aborted_at = clock_timestamp()
     WHERE id = p_round_id;
  END IF;

  FOR v_bet IN
    SELECT * FROM aviator_bets
     WHERE round_id = p_round_id AND status = 'active'
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM wallet_credit(
      v_bet.user_id, v_bet.stake_tzs, 'refund', 'aviator-refund-' || v_bet.id::text, 'cash',
      'aviator_bet', v_bet.id, 'aviator', NULL
    );
    UPDATE aviator_bets
       SET status = 'refunded', payout_tzs = v_bet.stake_tzs, settled_at = clock_timestamp()
     WHERE id = v_bet.id;
    v_count := v_count + 1;
  END LOOP;

  UPDATE aviator_state
     SET phase = 'idle', round_id = NULL, phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = 1 AND round_id = p_round_id;

  RETURN jsonb_build_object('refunded', v_count, 'status', 'aborted');
END;
$$;

REVOKE ALL ON FUNCTION aviator_multiplier(DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION place_aviator_bet_atomic(UUID, UUID, INT, BIGINT, NUMERIC, TEXT, BIGINT, BIGINT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION cashout_aviator_bet_atomic(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION aviator_auto_cashout(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION refund_aviator_round(UUID) FROM PUBLIC;
