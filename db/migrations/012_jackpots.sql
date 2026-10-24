-- Jackpots. Stakes, prizes, and refunds move only through wallet_debit / wallet_credit.
-- A postponed or cancelled fixture (status void, cancelled, postponed, or abandoned)
-- scores as void: every ticket is correct on that match, so the player is not
-- punished. If every match is void, settle refunds the stakes instead of paying
-- the grand prize. Settlement stays pending while any match is still undecided.

CREATE TABLE jackpots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('mega10', 'power8')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  grand_prize_tzs BIGINT NOT NULL CHECK (grand_prize_tzs > 0),
  tier_prizes JSONB NOT NULL DEFAULT '{}'::jsonb,
  closing_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  prize_pool_tzs BIGINT NOT NULL DEFAULT 0 CHECK (prize_pool_tzs >= 0),
  participants_count INTEGER NOT NULL DEFAULT 0 CHECK (participants_count >= 0),
  total_matches INTEGER NOT NULL CHECK (total_matches IN (8, 10)),
  created_by UUID REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jackpots_type_size CHECK (
    (type = 'mega10' AND total_matches = 10) OR (type = 'power8' AND total_matches = 8)
  )
);

CREATE TABLE jackpot_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jackpot_id UUID NOT NULL REFERENCES jackpots (id) ON DELETE CASCADE,
  match_id INT NOT NULL REFERENCES matches (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  correct_result TEXT CHECK (correct_result IN ('home', 'draw', 'away', 'void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (jackpot_id, position),
  UNIQUE (jackpot_id, match_id)
);

CREATE TABLE jackpot_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jackpot_id UUID NOT NULL REFERENCES jackpots (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id),
  selections JSONB NOT NULL,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'refunded')),
  prize_tzs BIGINT NOT NULL DEFAULT 0 CHECK (prize_tzs >= 0),
  client_ref TEXT NOT NULL UNIQUE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jackpot_tickets_user_idx ON jackpot_tickets (user_id, created_at DESC);
CREATE INDEX jackpot_tickets_jackpot_idx ON jackpot_tickets (jackpot_id);

CREATE OR REPLACE FUNCTION place_jackpot_ticket(
  p_user_id UUID,
  p_jackpot_id UUID,
  p_selections JSONB,
  p_client_ref TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jackpot jackpots%ROWTYPE;
  v_existing jackpot_tickets%ROWTYPE;
  v_pick TEXT;
  v_pos INTEGER;
  v_count INTEGER;
  v_ticket_id UUID;
  v_debit JSONB;
  v_started BOOLEAN;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  PERFORM assert_idempotency_key(p_client_ref);

  SELECT * INTO v_existing FROM jackpot_tickets WHERE client_ref = p_client_ref;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.jackpot_id <> p_jackpot_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'ticket_id', v_existing.id);
  END IF;

  SELECT * INTO v_jackpot FROM jackpots WHERE id = p_jackpot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jackpot_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM jackpot_tickets WHERE client_ref = p_client_ref;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.jackpot_id <> p_jackpot_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'ticket_id', v_existing.id);
  END IF;

  IF v_jackpot.status <> 'open' THEN
    RAISE EXCEPTION 'jackpot_closed' USING ERRCODE = 'P0001';
  END IF;
  IF v_jackpot.closing_time <= clock_timestamp() THEN
    RAISE EXCEPTION 'jackpot_closed_time' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_selections) <> 'object' THEN
    RAISE EXCEPTION 'jackpot_selections' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_object_keys(p_selections);
  IF v_count <> v_jackpot.total_matches THEN
    RAISE EXCEPTION 'jackpot_selections' USING ERRCODE = '22023';
  END IF;
  FOR v_pos IN 1..v_jackpot.total_matches LOOP
    v_pick := p_selections ->> v_pos::text;
    IF v_pick IS NULL OR v_pick NOT IN ('home', 'draw', 'away') THEN
      RAISE EXCEPTION 'jackpot_selections' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
      FROM jackpot_matches jm
      JOIN matches m ON m.id = jm.match_id
     WHERE jm.jackpot_id = p_jackpot_id
       AND (m.status <> 'upcoming' OR m.kickoff_at <= clock_timestamp())
  ) INTO v_started;
  IF v_started THEN
    RAISE EXCEPTION 'jackpot_match_started' USING ERRCODE = 'P0001';
  END IF;

  v_debit := wallet_debit(
    p_user_id,
    v_jackpot.stake_tzs,
    'bet_stake',
    'jackpot_stake:' || p_client_ref,
    'cash',
    'jackpot',
    p_jackpot_id,
    NULL,
    NULL
  );

  INSERT INTO jackpot_tickets (jackpot_id, user_id, selections, stake_tzs, client_ref)
  VALUES (p_jackpot_id, p_user_id, p_selections, v_jackpot.stake_tzs, p_client_ref)
  RETURNING id INTO v_ticket_id;

  UPDATE jackpots
     SET prize_pool_tzs = prize_pool_tzs + v_jackpot.stake_tzs,
         participants_count = participants_count + 1,
         updated_at = now()
   WHERE id = p_jackpot_id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'ticket_id', v_ticket_id,
    'balance_tzs', v_debit -> 'balance_tzs',
    'ledger_id', v_debit -> 'ledger_id'
  );
END;
$$;

CREATE OR REPLACE FUNCTION settle_jackpot(
  p_jackpot_id UUID,
  p_results JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jackpot jackpots%ROWTYPE;
  v_match RECORD;
  v_ticket jackpot_tickets%ROWTYPE;
  v_results JSONB := '{}'::jsonb;
  v_override TEXT;
  v_actual TEXT;
  v_pick TEXT;
  v_pos INTEGER;
  v_correct INTEGER;
  v_voids INTEGER := 0;
  v_seen INTEGER := 0;
  v_prize BIGINT;
  v_paid INTEGER := 0;
  v_refunded INTEGER := 0;
  v_pending BOOLEAN := FALSE;
BEGIN
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'object' THEN
    RAISE EXCEPTION 'jackpot_results' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_jackpot FROM jackpots WHERE id = p_jackpot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jackpot_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_jackpot.status = 'settled' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'paid', 0);
  END IF;
  IF v_jackpot.status = 'cancelled' THEN
    RAISE EXCEPTION 'jackpot_cancelled' USING ERRCODE = 'P0001';
  END IF;

  FOR v_match IN
    SELECT jm.position, m.status, m.home_score, m.away_score
      FROM jackpot_matches jm
      JOIN matches m ON m.id = jm.match_id
     WHERE jm.jackpot_id = p_jackpot_id
     ORDER BY jm.position
  LOOP
    v_seen := v_seen + 1;
    v_override := p_results ->> v_match.position::text;
    IF v_override IN ('home', 'draw', 'away', 'void') THEN
      v_actual := v_override;
    ELSIF v_match.status = 'finished' THEN
      v_actual := CASE
        WHEN COALESCE(v_match.home_score, 0) > COALESCE(v_match.away_score, 0) THEN 'home'
        WHEN COALESCE(v_match.home_score, 0) < COALESCE(v_match.away_score, 0) THEN 'away'
        ELSE 'draw'
      END;
    ELSIF v_match.status IN ('void', 'cancelled', 'postponed', 'abandoned') THEN
      v_actual := 'void';
    ELSE
      v_pending := TRUE;
      v_actual := NULL;
    END IF;
    IF v_actual = 'void' THEN
      v_voids := v_voids + 1;
    END IF;
    IF NOT v_pending THEN
      v_results := v_results || jsonb_build_object(v_match.position::text, v_actual);
    END IF;
  END LOOP;

  IF v_seen <> v_jackpot.total_matches THEN
    RAISE EXCEPTION 'jackpot_matches_missing' USING ERRCODE = 'P0001';
  END IF;
  IF v_pending THEN
    RETURN jsonb_build_object('ok', true, 'pending', true, 'paid', 0);
  END IF;

  FOR v_pos IN 1..v_jackpot.total_matches LOOP
    UPDATE jackpot_matches
       SET correct_result = v_results ->> v_pos::text
     WHERE jackpot_id = p_jackpot_id AND position = v_pos;
  END LOOP;

  IF v_voids = v_jackpot.total_matches THEN
    FOR v_ticket IN
      SELECT * FROM jackpot_tickets
       WHERE jackpot_id = p_jackpot_id AND status = 'pending'
       ORDER BY id
       FOR UPDATE
    LOOP
      PERFORM wallet_credit(
        v_ticket.user_id,
        v_ticket.stake_tzs,
        'refund',
        'jackpot_refund:' || v_ticket.id::text,
        'cash',
        'jackpot_ticket',
        v_ticket.id,
        NULL,
        NULL
      );
      UPDATE jackpot_tickets
         SET status = 'refunded', prize_tzs = 0, correct_count = 0, updated_at = now()
       WHERE id = v_ticket.id;
      v_refunded := v_refunded + 1;
    END LOOP;
    UPDATE jackpots SET status = 'cancelled', updated_at = now() WHERE id = p_jackpot_id;
    RETURN jsonb_build_object('ok', true, 'all_void', true, 'refunded', v_refunded, 'paid', 0);
  END IF;

  FOR v_ticket IN
    SELECT * FROM jackpot_tickets
     WHERE jackpot_id = p_jackpot_id AND status = 'pending'
     ORDER BY id
     FOR UPDATE
  LOOP
    v_correct := 0;
    FOR v_pos IN 1..v_jackpot.total_matches LOOP
      v_pick := v_ticket.selections ->> v_pos::text;
      v_actual := v_results ->> v_pos::text;
      IF v_actual = 'void' OR v_pick = v_actual THEN
        v_correct := v_correct + 1;
      END IF;
    END LOOP;

    v_prize := 0;
    IF v_correct = v_jackpot.total_matches THEN
      v_prize := v_jackpot.grand_prize_tzs;
    ELSIF v_jackpot.tier_prizes ? v_correct::text THEN
      v_prize := (v_jackpot.tier_prizes ->> v_correct::text)::bigint;
    END IF;
    IF v_prize IS NULL OR v_prize < 0 THEN
      RAISE EXCEPTION 'jackpot_prize' USING ERRCODE = '22023';
    END IF;

    UPDATE jackpot_tickets
       SET correct_count = v_correct,
           prize_tzs = v_prize,
           status = CASE WHEN v_prize > 0 THEN 'won' ELSE 'lost' END,
           paid_at = CASE WHEN v_prize > 0 THEN now() ELSE NULL END,
           updated_at = now()
     WHERE id = v_ticket.id;

    IF v_prize > 0 THEN
      PERFORM wallet_credit(
        v_ticket.user_id,
        v_prize,
        'bet_win',
        'jackpot_payout:' || v_ticket.id::text,
        'cash',
        'jackpot_ticket',
        v_ticket.id,
        NULL,
        NULL
      );
      INSERT INTO notifications (user_id, title, body)
      VALUES (
        v_ticket.user_id,
        'Umeshinda Jackpot',
        left('Umeshinda TSH ' || v_prize::text || ' (' || v_correct || '/' || v_jackpot.total_matches || ') kwenye ' || v_jackpot.name, 500)
      );
      v_paid := v_paid + 1;
    END IF;
  END LOOP;

  UPDATE jackpots SET status = 'settled', updated_at = now() WHERE id = p_jackpot_id;
  RETURN jsonb_build_object('ok', true, 'pending', false, 'paid', v_paid, 'refunded', 0);
END;
$$;

CREATE OR REPLACE FUNCTION cancel_jackpot(p_jackpot_id UUID) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jackpot jackpots%ROWTYPE;
  v_ticket jackpot_tickets%ROWTYPE;
  v_refunded INTEGER := 0;
BEGIN
  SELECT * INTO v_jackpot FROM jackpots WHERE id = p_jackpot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jackpot_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_jackpot.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'refunded', 0);
  END IF;
  IF v_jackpot.status = 'settled' THEN
    RAISE EXCEPTION 'jackpot_settled' USING ERRCODE = 'P0001';
  END IF;

  FOR v_ticket IN
    SELECT * FROM jackpot_tickets
     WHERE jackpot_id = p_jackpot_id AND status = 'pending'
     ORDER BY id
     FOR UPDATE
  LOOP
    PERFORM wallet_credit(
      v_ticket.user_id,
      v_ticket.stake_tzs,
      'refund',
      'jackpot_refund:' || v_ticket.id::text,
      'cash',
      'jackpot_ticket',
      v_ticket.id,
      NULL,
      NULL
    );
    UPDATE jackpot_tickets
       SET status = 'refunded', prize_tzs = 0, updated_at = now()
     WHERE id = v_ticket.id;
    v_refunded := v_refunded + 1;
  END LOOP;

  UPDATE jackpots SET status = 'cancelled', updated_at = now() WHERE id = p_jackpot_id;
  RETURN jsonb_build_object('ok', true, 'refunded', v_refunded);
END;
$$;
