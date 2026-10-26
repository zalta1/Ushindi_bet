-- Aviator admin. The budget row counts stakes and payouts. Nothing in this
-- migration lets an admin set a crash point or pick a winner. The crash
-- is still the hash written when the round opens.
-- Stake limits and the crash-display wait are stored on the round so a
-- settings save cannot change a round that has already opened.

ALTER TABLE aviator_rounds
  ADD COLUMN min_stake_tzs BIGINT NOT NULL DEFAULT 100,
  ADD COLUMN max_stake_tzs BIGINT NOT NULL DEFAULT 2000000,
  ADD COLUMN crashed_ms INT NOT NULL DEFAULT 5000,
  ADD COLUMN budget_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE aviator_rounds
  ADD CONSTRAINT aviator_rounds_stakes_ck CHECK (min_stake_tzs >= 1 AND max_stake_tzs >= min_stake_tzs),
  ADD CONSTRAINT aviator_rounds_crashed_ms_ck CHECK (crashed_ms BETWEEN 1000 AND 60000);

CREATE TABLE aviator_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO aviator_budget (id) VALUES (TRUE);

CREATE TABLE aviator_suspensions (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX aviator_bets_user_idx ON aviator_bets (user_id, created_at DESC);

-- Stake limits come from the round row. p_min_stake and p_max_stake are ignored
-- so a settings save applies on the next round only. A suspension blocks a new
-- bet. Replaying an existing idempotency key still returns that bet.
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
  v_min BIGINT;
  v_max BIGINT;
  v_bet_id UUID;
  v_ledger JSONB;
  v_balance BIGINT;
BEGIN
  PERFORM assert_idempotency_key(p_idempotency_key);
  IF p_panel NOT IN (1, 2) THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
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

  IF EXISTS (
    SELECT 1 FROM aviator_suspensions WHERE user_id = p_user_id AND active
  ) THEN
    RAISE EXCEPTION 'aviator_suspended' USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_enabled THEN
    RAISE EXCEPTION 'game_disabled' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.phase, s.round_id, r.betting_ends_at, r.max_multiplier, r.min_stake_tzs, r.max_stake_tzs
    INTO v_phase, v_state_round, v_ends, v_max_mult, v_min, v_max
    FROM aviator_state s
    JOIN aviator_rounds r ON r.id = s.round_id
   WHERE s.id = 1
   FOR UPDATE OF s;

  IF v_phase IS DISTINCT FROM 'betting' OR v_state_round IS DISTINCT FROM p_round_id
     OR v_ends IS NULL OR clock_timestamp() >= v_ends THEN
    RAISE EXCEPTION 'betting_closed' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount < v_min OR p_amount > v_max THEN
    RAISE EXCEPTION 'invalid_stake' USING ERRCODE = '22023';
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

  UPDATE aviator_budget
     SET total_bets_tzs = total_bets_tzs + p_amount
   WHERE id;

  RETURN jsonb_build_object(
    'idempotent', false,
    'bet_id', v_bet_id,
    'balance_tzs', v_ledger->'balance_tzs',
    'stake_tzs', p_amount,
    'panel', p_panel
  );
END;
$$;

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

  UPDATE aviator_budget
     SET total_payouts_tzs = total_payouts_tzs + v_payout
   WHERE id;

  RETURN jsonb_build_object(
    'idempotent', COALESCE((v_ledger->>'idempotent')::boolean, false),
    'bet_id', v_bet.id,
    'multiplier', v_mult,
    'payout_tzs', v_payout,
    'balance_tzs', v_ledger->'balance_tzs'
  );
END;
$$;

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
    UPDATE aviator_budget
       SET total_payouts_tzs = total_payouts_tzs + v_payout
     WHERE id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

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
    UPDATE aviator_budget
       SET total_bets_tzs = GREATEST(0, total_bets_tzs - v_bet.stake_tzs)
     WHERE id;
    v_count := v_count + 1;
  END LOOP;

  UPDATE aviator_state
     SET phase = 'idle', round_id = NULL, phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = 1 AND round_id = p_round_id;

  RETURN jsonb_build_object('refunded', v_count, 'status', 'aborted');
END;
$$;
