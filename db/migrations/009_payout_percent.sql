-- Winning bets pay the percent stored on the ticket. The default for a new
-- bet is 8800 (88%). Bets placed before this migration keep 10000, so their
-- already quoted payout is unchanged. Voids and refunds stay at 100% of stake.
-- Cash out uses its own margin and cannot exceed the win this ticket would pay.

ALTER TABLE bets ADD COLUMN IF NOT EXISTS payout_percent_bps INT;
UPDATE bets SET payout_percent_bps = 10000 WHERE payout_percent_bps IS NULL;
ALTER TABLE bets ALTER COLUMN payout_percent_bps SET DEFAULT 8800;
ALTER TABLE bets ALTER COLUMN payout_percent_bps SET NOT NULL;

DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'bets'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%potential_payout_tzs%'
       AND con.conname <> 'bets_potential_payout_positive'
  LOOP
    EXECUTE format('ALTER TABLE bets DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_potential_payout_positive;
ALTER TABLE bets ADD CONSTRAINT bets_potential_payout_positive CHECK (potential_payout_tzs > 0);

CREATE OR REPLACE FUNCTION quoted_payout(p_stake BIGINT, p_odds NUMERIC, p_percent INT)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT floor(p_stake::numeric * p_odds * p_percent::numeric / 10000)::bigint;
$$;

CREATE OR REPLACE FUNCTION quote_bet(p_stake BIGINT, p_prices NUMERIC[], p_percent INT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $quote_bet$
DECLARE
  v_odds NUMERIC := 1;
  v_price NUMERIC;
  v_count INT;
BEGIN
  IF p_stake IS NULL OR p_stake < 1 OR p_stake > 100000000 THEN
    RAISE EXCEPTION 'invalid_stake' USING ERRCODE = '22023';
  END IF;
  IF p_percent IS NULL OR p_percent < 1 OR p_percent > 10000 THEN
    RAISE EXCEPTION 'invalid_payout_percent' USING ERRCODE = '22023';
  END IF;
  v_count := COALESCE(array_length(p_prices, 1), 0);
  IF v_count < 1 OR v_count > 20 THEN
    RAISE EXCEPTION 'invalid_legs' USING ERRCODE = '22023';
  END IF;
  FOREACH v_price IN ARRAY p_prices LOOP
    IF v_price IS NULL OR v_price <= 1 OR v_price > 1000 THEN
      RAISE EXCEPTION 'invalid_odds' USING ERRCODE = '22023';
    END IF;
    v_odds := v_odds * v_price;
  END LOOP;
  RETURN jsonb_build_object(
    'combined_odds', v_odds,
    'potential_payout_tzs', quoted_payout(p_stake, v_odds, p_percent),
    'payout_percent_bps', p_percent
  );
END;
$quote_bet$;

DROP FUNCTION IF EXISTS place_bet_atomic(UUID, BIGINT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION place_bet_atomic(
  p_user_id UUID,
  p_stake BIGINT,
  p_legs JSONB,
  p_idempotency_key TEXT,
  p_payout_percent_bps INT DEFAULT 8800
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $place$
DECLARE
  v_existing bets%ROWTYPE;
  v_leg JSONB;
  v_price NUMERIC;
  v_odds NUMERIC := 1;
  v_payout BIGINT;
  v_bet_id UUID;
  v_debit JSONB;
  v_balance BIGINT;
  v_bonus BIGINT;
  v_count INT;
BEGIN
  PERFORM assert_idempotency_key(p_idempotency_key);
  IF length(p_idempotency_key) > 180 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_stake IS NULL OR p_stake <= 0 OR p_stake > 100000000 THEN
    RAISE EXCEPTION 'invalid_stake' USING ERRCODE = '22023';
  END IF;
  IF p_payout_percent_bps IS NULL OR p_payout_percent_bps < 1 OR p_payout_percent_bps > 10000 THEN
    RAISE EXCEPTION 'invalid_payout_percent' USING ERRCODE = '22023';
  END IF;
  IF p_legs IS NULL OR jsonb_typeof(p_legs) <> 'array' THEN
    RAISE EXCEPTION 'invalid_legs' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_legs);
  IF v_count < 1 OR v_count > 20 THEN
    RAISE EXCEPTION 'invalid_legs' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM bets WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.stake_tzs <> p_stake THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT balance_tzs, bonus_balance_tzs INTO v_balance, v_bonus
      FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'idempotent', true,
      'bet_id', v_existing.id,
      'stake_tzs', v_existing.stake_tzs,
      'combined_odds', v_existing.combined_odds,
      'potential_payout_tzs', v_existing.potential_payout_tzs,
      'payout_percent_bps', v_existing.payout_percent_bps,
      'balance_tzs', v_balance,
      'bonus_balance_tzs', v_bonus
    );
  END IF;

  FOR v_leg IN SELECT value FROM jsonb_array_elements(p_legs)
  LOOP
    IF v_leg->>'market' IS NULL OR v_leg->>'selection' IS NULL OR v_leg->>'odds' IS NULL THEN
      RAISE EXCEPTION 'invalid_legs' USING ERRCODE = '22023';
    END IF;
    v_price := (v_leg->>'odds')::numeric;
    IF v_price <= 1 OR v_price > 1000 THEN
      RAISE EXCEPTION 'invalid_odds' USING ERRCODE = '22023';
    END IF;
    v_odds := v_odds * v_price;
  END LOOP;

  IF p_stake * v_odds > 9223372036854775807 THEN
    RAISE EXCEPTION 'payout_overflow' USING ERRCODE = '22023';
  END IF;
  v_payout := quoted_payout(p_stake, v_odds, p_payout_percent_bps);
  IF v_payout IS NULL OR v_payout < 1 THEN
    RAISE EXCEPTION 'invalid_payout' USING ERRCODE = '22023';
  END IF;
  v_bet_id := gen_random_uuid();

  v_debit := wallet_debit(
    p_user_id,
    p_stake,
    'bet_stake',
    p_idempotency_key || ':stake',
    'cash',
    'bet',
    v_bet_id,
    NULL,
    NULL
  );

  BEGIN
    INSERT INTO bets (id, user_id, stake_tzs, combined_odds, potential_payout_tzs, payout_percent_bps, idempotency_key)
    VALUES (v_bet_id, p_user_id, p_stake, v_odds, v_payout, p_payout_percent_bps, p_idempotency_key);

    INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_at_placement, odds_id)
    SELECT v_bet_id,
           NULLIF(leg->>'match_id', '')::int,
           leg->>'market',
           leg->>'selection',
           (leg->>'odds')::numeric,
           NULLIF(leg->>'odds_id', '')::int
      FROM jsonb_array_elements(p_legs) AS leg;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM bets WHERE idempotency_key = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    IF v_existing.user_id <> p_user_id OR v_existing.stake_tzs <> p_stake THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT balance_tzs, bonus_balance_tzs INTO v_balance, v_bonus
      FROM wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'idempotent', true,
      'bet_id', v_existing.id,
      'stake_tzs', v_existing.stake_tzs,
      'combined_odds', v_existing.combined_odds,
      'potential_payout_tzs', v_existing.potential_payout_tzs,
      'payout_percent_bps', v_existing.payout_percent_bps,
      'balance_tzs', v_balance,
      'bonus_balance_tzs', v_bonus
    );
  END;

  RETURN jsonb_build_object(
    'idempotent', false,
    'bet_id', v_bet_id,
    'stake_tzs', p_stake,
    'combined_odds', v_odds,
    'potential_payout_tzs', v_payout,
    'payout_percent_bps', p_payout_percent_bps,
    'balance_tzs', (v_debit->>'balance_tzs')::bigint,
    'bonus_balance_tzs', (v_debit->>'bonus_balance_tzs')::bigint
  );
END;
$place$;

CREATE OR REPLACE FUNCTION settle_match_atomic(
  p_match_id INT,
  p_home INT,
  p_away INT,
  p_actor UUID,
  p_void BOOLEAN,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $settle$
DECLARE
  v_match matches%ROWTYPE;
  v_bet bets%ROWTYPE;
  v_leg RECORD;
  v_lost INT;
  v_open INT;
  v_won INT;
  v_voids INT;
  v_product NUMERIC;
  v_payout BIGINT;
  v_credited BIGINT := 0;
  v_bets INT := 0;
  v_phone TEXT := 'system';
  v_status TEXT;
  v_grade TEXT;
BEGIN
  IF p_match_id IS NULL THEN
    RAISE EXCEPTION 'match_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(p_void, false) THEN
    IF p_home IS NULL OR p_away IS NULL OR p_home < 0 OR p_away < 0 OR p_home > 99 OR p_away > 99 THEN
      RAISE EXCEPTION 'invalid_score' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_actor IS NOT NULL THEN
    SELECT phone INTO v_phone FROM users WHERE id = p_actor;
    IF v_phone IS NULL THEN
      v_phone := 'system';
    END IF;
  END IF;

  IF v_match.status IN ('finished', 'void') THEN
    INSERT INTO audit_log (actor_user_id, actor, action, payload)
    VALUES (
      p_actor,
      v_phone,
      'match.settle',
      jsonb_build_object(
        'match_id', p_match_id,
        'already_settled', true,
        'status', v_match.status,
        'reason', left(coalesce(p_reason, ''), 200)
      )
    );
    RETURN jsonb_build_object(
      'already_settled', true,
      'status', v_match.status,
      'bets_settled', 0,
      'credited_tzs', 0
    );
  END IF;

  IF COALESCE(p_void, false) THEN
    v_status := 'void';
    UPDATE matches
       SET status = 'void', settled_at = now()
     WHERE id = p_match_id;
    UPDATE bet_legs
       SET status = 'void'
     WHERE match_id = p_match_id AND status = 'open';
  ELSE
    v_status := 'finished';
    UPDATE matches
       SET status = 'finished',
           home_score = p_home,
           away_score = p_away,
           settled_at = now()
     WHERE id = p_match_id;

    FOR v_leg IN
      SELECT l.id, l.market, l.selection, mk.code, mk.line
        FROM bet_legs l
        LEFT JOIN odds o ON o.id = l.odds_id
        LEFT JOIN markets mk ON mk.id = o.market_id
       WHERE l.match_id = p_match_id AND l.status = 'open'
    LOOP
      v_grade := grade_selection(COALESCE(v_leg.code, v_leg.market), v_leg.selection, v_leg.line, p_home, p_away);
      UPDATE bet_legs SET status = v_grade WHERE id = v_leg.id;
    END LOOP;
  END IF;

  FOR v_bet IN
    SELECT b.*
      FROM bets b
     WHERE b.status = 'open'
       AND EXISTS (
         SELECT 1 FROM bet_legs l WHERE l.bet_id = b.id AND l.match_id = p_match_id
       )
     FOR UPDATE
  LOOP
    SELECT
      count(*) FILTER (WHERE status = 'lost'),
      count(*) FILTER (WHERE status = 'open'),
      count(*) FILTER (WHERE status = 'won'),
      count(*) FILTER (WHERE status = 'void')
      INTO v_lost, v_open, v_won, v_voids
      FROM bet_legs
     WHERE bet_id = v_bet.id;

    IF v_lost > 0 THEN
      UPDATE bets SET status = 'lost', settled_at = now() WHERE id = v_bet.id;
      v_bets := v_bets + 1;
    ELSIF v_open > 0 THEN
      NULL;
    ELSIF v_won = 0 THEN
      PERFORM wallet_credit(
        v_bet.user_id,
        v_bet.stake_tzs,
        'refund',
        'settle-refund-' || v_bet.id::text,
        'cash',
        'bet',
        v_bet.id,
        'settlement',
        NULL
      );
      UPDATE bets SET status = 'void', settled_at = now() WHERE id = v_bet.id;
      v_credited := v_credited + v_bet.stake_tzs;
      v_bets := v_bets + 1;
    ELSE
      IF v_voids = 0 THEN
        v_payout := v_bet.potential_payout_tzs;
      ELSE
        v_product := 1;
        FOR v_leg IN
          SELECT odds_at_placement
            FROM bet_legs
           WHERE bet_id = v_bet.id AND status = 'won'
        LOOP
          v_product := v_product * v_leg.odds_at_placement;
        END LOOP;
        v_payout := quoted_payout(v_bet.stake_tzs, v_product, v_bet.payout_percent_bps);
      END IF;
      IF v_payout IS NULL OR v_payout <= 0 THEN
        RAISE EXCEPTION 'invalid_payout' USING ERRCODE = '22023';
      END IF;
      PERFORM wallet_credit(
        v_bet.user_id,
        v_payout,
        'bet_win',
        'settle-win-' || v_bet.id::text,
        'cash',
        'bet',
        v_bet.id,
        'settlement',
        NULL
      );
      UPDATE bets SET status = 'won', settled_at = now() WHERE id = v_bet.id;
      v_credited := v_credited + v_payout;
      v_bets := v_bets + 1;
    END IF;
  END LOOP;

  INSERT INTO audit_log (actor_user_id, actor, action, payload)
  VALUES (
    p_actor,
    v_phone,
    CASE WHEN v_status = 'void' THEN 'match.void' ELSE 'match.settle' END,
    jsonb_build_object(
      'match_id', p_match_id,
      'home_score', p_home,
      'away_score', p_away,
      'status', v_status,
      'reason', left(coalesce(p_reason, ''), 200),
      'bets_settled', v_bets,
      'credited_tzs', v_credited,
      'already_settled', false
    )
  );

  RETURN jsonb_build_object(
    'already_settled', false,
    'status', v_status,
    'bets_settled', v_bets,
    'credited_tzs', v_credited
  );
END;
$settle$;

CREATE OR REPLACE FUNCTION process_two_up(p_match_id INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $twoup$
DECLARE
  v_match matches%ROWTYPE;
  v_leg RECORD;
  v_diff INT;
  v_minute INT;
  v_sel TEXT;
  v_market TEXT;
  v_eligible BOOLEAN;
  v_team TEXT;
  v_attempt INT;
  v_payout BIGINT;
  v_product NUMERIC;
  v_legs INT;
  v_lost INT;
  v_open INT;
  v_won INT;
  v_voids INT;
  v_paid INT := 0;
  v_reversed INT := 0;
  v_other RECORD;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_match.two_up_enabled IS NOT TRUE OR v_match.status NOT IN ('live', 'upcoming') THEN
    RETURN jsonb_build_object('paid', 0, 'reversed', 0, 'skipped', true);
  END IF;

  v_diff := COALESCE(v_match.home_score, 0) - COALESCE(v_match.away_score, 0);
  v_minute := COALESCE(v_match.minute, 0);
  v_team := COALESCE(v_match.two_up_team, 'both');
  IF v_match.two_up_first_leader IS NULL THEN
    IF v_diff >= 2 THEN
      v_match.two_up_first_leader := 'home';
    ELSIF v_diff <= -2 THEN
      v_match.two_up_first_leader := 'away';
    END IF;
    UPDATE matches SET two_up_first_leader = v_match.two_up_first_leader WHERE id = p_match_id;
  END IF;

  FOR v_leg IN
    SELECT l.id, l.bet_id, l.market, l.selection, l.status, l.odds_at_placement,
           l.two_up_paid_at, l.two_up_attempt, l.two_up_paid_amount,
           b.user_id, b.stake_tzs, b.status AS bet_status, b.potential_payout_tzs, b.payout_percent_bps
      FROM bet_legs l
      JOIN bets b ON b.id = l.bet_id
     WHERE l.match_id = p_match_id
       AND b.status IN ('open', 'won')
       AND l.status IN ('open', 'won')
       AND lower(l.market) IN ('2up', '1x2', 'double chance')
     FOR UPDATE OF l, b
  LOOP
    v_sel := lower(trim(v_leg.selection));
    v_market := lower(trim(v_leg.market));
    v_eligible := false;
    IF v_market = '2up' AND v_sel IN ('1', 'home') AND v_diff >= 2 THEN
      v_eligible := true;
    ELSIF v_market = '2up' AND v_sel IN ('2', 'away') AND v_diff <= -2 THEN
      v_eligible := true;
    ELSIF v_market = '1x2' AND v_sel IN ('1', 'home') AND v_diff >= 2 AND v_team IN ('home', 'both') THEN
      v_eligible := true;
    ELSIF v_market = '1x2' AND v_sel IN ('2', 'away') AND v_diff <= -2 AND v_team IN ('away', 'both') THEN
      v_eligible := true;
    ELSIF v_market = 'double chance' AND v_sel IN ('1x', 'dc_1x') AND v_match.two_up_first_leader = 'home' AND v_diff >= 2 AND v_team IN ('home', 'both') THEN
      v_eligible := true;
    ELSIF v_market = 'double chance' AND v_sel IN ('x2', 'dc_x2') AND v_match.two_up_first_leader = 'away' AND v_diff <= -2 AND v_team IN ('away', 'both') THEN
      v_eligible := true;
    END IF;

    IF v_eligible AND v_leg.status = 'open' AND v_leg.two_up_paid_at IS NULL AND v_leg.bet_status = 'open' AND v_minute <= 88 THEN
      v_attempt := COALESCE(v_leg.two_up_attempt, 0) + 1;
      SELECT count(*) INTO v_legs FROM bet_legs WHERE bet_id = v_leg.bet_id;
      IF v_legs = 1 THEN
        v_payout := v_leg.potential_payout_tzs;
        PERFORM wallet_credit(
          v_leg.user_id, v_payout, 'bet_win',
          'two-up-' || v_leg.bet_id::text || '-' || v_attempt::text,
          'cash', 'bet', v_leg.bet_id, '2up', NULL
        );
        UPDATE bet_legs
           SET status = 'won', two_up_paid_at = now(), two_up_attempt = v_attempt, two_up_paid_amount = v_payout
         WHERE id = v_leg.id;
        UPDATE bets SET status = 'won', settled_at = now() WHERE id = v_leg.bet_id;
        INSERT INTO notifications (user_id, title, body)
        VALUES (
          v_leg.user_id,
          '2UP Early Payout',
          left('Hongera! Timu yako imeongoza kwa magoli 2. Umelipwa TSH ' || v_payout::text || ' mapema.', 500)
        );
      ELSE
        UPDATE bet_legs
           SET status = 'won', two_up_paid_at = now(), two_up_attempt = v_attempt, two_up_paid_amount = NULL
         WHERE id = v_leg.id;
        SELECT
          count(*) FILTER (WHERE status = 'lost'),
          count(*) FILTER (WHERE status = 'open'),
          count(*) FILTER (WHERE status = 'won'),
          count(*) FILTER (WHERE status = 'void')
          INTO v_lost, v_open, v_won, v_voids
          FROM bet_legs
         WHERE bet_id = v_leg.bet_id;
        IF v_lost = 0 AND v_open = 0 AND v_won > 0 THEN
          IF v_voids = 0 THEN
            v_payout := v_leg.potential_payout_tzs;
          ELSE
            v_product := 1;
            FOR v_other IN
              SELECT odds_at_placement FROM bet_legs WHERE bet_id = v_leg.bet_id AND status = 'won'
            LOOP
              v_product := v_product * v_other.odds_at_placement;
            END LOOP;
            v_payout := quoted_payout(v_leg.stake_tzs, v_product, v_leg.payout_percent_bps);
          END IF;
          PERFORM wallet_credit(
            v_leg.user_id, v_payout, 'bet_win',
            'two-up-done-' || v_leg.bet_id::text || '-' || v_attempt::text,
            'cash', 'bet', v_leg.bet_id, '2up', NULL
          );
          UPDATE bet_legs SET two_up_paid_amount = v_payout WHERE id = v_leg.id;
          UPDATE bets SET status = 'won', settled_at = now() WHERE id = v_leg.bet_id;
        END IF;
      END IF;
      INSERT INTO audit_log (actor_user_id, actor, action, payload)
      VALUES (NULL, 'system', 'two_up.pay', jsonb_build_object('match_id', p_match_id, 'bet_id', v_leg.bet_id, 'leg_id', v_leg.id, 'attempt', v_attempt));
      v_paid := v_paid + 1;
    ELSIF NOT v_eligible AND v_leg.status = 'won' AND v_leg.two_up_paid_at IS NOT NULL THEN
      IF v_leg.two_up_paid_amount IS NOT NULL AND v_leg.two_up_paid_amount > 0 AND v_leg.bet_status = 'won' THEN
        PERFORM wallet_debit(
          v_leg.user_id, v_leg.two_up_paid_amount, 'adjustment',
          'two-up-rev-' || v_leg.bet_id::text || '-' || v_leg.two_up_attempt::text,
          'cash', 'bet', v_leg.bet_id, '2up_reversal', NULL
        );
        UPDATE bets SET status = 'open', settled_at = NULL WHERE id = v_leg.bet_id;
        INSERT INTO notifications (user_id, title, body)
        VALUES (
          v_leg.user_id,
          'VAR: 2UP Imerudishwa',
          'Goli limefutwa na VAR. Bet yako imerudi hai. Itashindwa tena timu ikifika +2 kabla ya mwisho.'
        );
        v_reversed := v_reversed + 1;
        INSERT INTO audit_log (actor_user_id, actor, action, payload)
        VALUES (NULL, 'system', 'two_up.reverse', jsonb_build_object('match_id', p_match_id, 'bet_id', v_leg.bet_id, 'leg_id', v_leg.id, 'amount_tzs', v_leg.two_up_paid_amount));
      ELSIF v_leg.bet_status = 'open' THEN
        v_reversed := v_reversed + 1;
        INSERT INTO audit_log (actor_user_id, actor, action, payload)
        VALUES (NULL, 'system', 'two_up.reverse', jsonb_build_object('match_id', p_match_id, 'bet_id', v_leg.bet_id, 'leg_id', v_leg.id, 'amount_tzs', 0));
      ELSE
        CONTINUE;
      END IF;
      UPDATE bet_legs
         SET status = 'open', two_up_paid_at = NULL, two_up_paid_amount = NULL
       WHERE id = v_leg.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('paid', v_paid, 'reversed', v_reversed, 'skipped', false);
END;
$twoup$;

CREATE OR REPLACE FUNCTION cashout_value(
  p_user_id UUID,
  p_bet_id UUID,
  p_margin_bps INT
) RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $quote$
DECLARE
  v_bet bets%ROWTYPE;
  v_leg RECORD;
  v_price NUMERIC;
  v_suspended BOOLEAN;
  v_status TEXT;
  v_product NUMERIC := 1;
  v_win_odds NUMERIC := 1;
  v_priced BOOLEAN := false;
  v_value BIGINT;
  v_cap BIGINT;
BEGIN
  IF p_margin_bps IS NULL OR p_margin_bps < 0 OR p_margin_bps > 5000 THEN
    RAISE EXCEPTION 'invalid_margin' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_bet FROM bets WHERE id = p_bet_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bet_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_bet.status <> 'open' THEN
    RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
  END IF;
  FOR v_leg IN
    SELECT l.status, l.odds_at_placement, l.odds_id, l.match_id
      FROM bet_legs l
     WHERE l.bet_id = p_bet_id
  LOOP
    IF v_leg.status = 'lost' THEN
      RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
    ELSIF v_leg.status = 'void' THEN
      NULL;
    ELSIF v_leg.status = 'won' THEN
      v_product := v_product * v_leg.odds_at_placement;
      v_win_odds := v_win_odds * v_leg.odds_at_placement;
      v_priced := true;
    ELSIF v_leg.status = 'open' THEN
      SELECT o.price, o.suspended, m.status
        INTO v_price, v_suspended, v_status
        FROM odds o
        JOIN markets mk ON mk.id = o.market_id
        JOIN matches m ON m.id = mk.match_id
       WHERE o.id = v_leg.odds_id;
      IF v_price IS NULL OR v_suspended OR v_status NOT IN ('upcoming', 'live') THEN
        RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
      END IF;
      v_product := v_product * (v_leg.odds_at_placement / v_price);
      v_win_odds := v_win_odds * v_leg.odds_at_placement;
      v_priced := true;
    ELSE
      RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  v_value := floor(v_bet.stake_tzs * v_product * (10000 - p_margin_bps) / 10000.0)::bigint;
  IF v_priced THEN
    v_cap := quoted_payout(v_bet.stake_tzs, v_win_odds, v_bet.payout_percent_bps);
  ELSE
    v_cap := v_bet.stake_tzs;
  END IF;
  IF v_value IS NULL OR v_cap IS NULL OR v_cap < 1 THEN
    RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
  END IF;
  v_value := LEAST(v_value, v_cap);
  IF v_value < 1 THEN
    RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_value;
END;
$quote$;

REVOKE ALL ON FUNCTION place_bet_atomic(UUID, BIGINT, JSONB, TEXT, INT) FROM PUBLIC;
