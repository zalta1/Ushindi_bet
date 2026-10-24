-- Correct score, handicaps, hot matches, 2UP early payout, and cashout.
-- Wins still pay the quoted amount. PesaBetPro's 0.88 haircut is the cashout
-- margin (cashoutMarginBps 1200), not the settlement payout.
-- 2UP early payout and cashout both move money only through wallet_credit / wallet_debit.

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS is_hot_match BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_up_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_up_home_odds NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS two_up_draw_odds NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS two_up_away_odds NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS two_up_first_leader TEXT,
  ADD COLUMN IF NOT EXISTS two_up_team TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS api_home_id INT,
  ADD COLUMN IF NOT EXISTS api_away_id INT;

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_two_up_team_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_two_up_team_check CHECK (two_up_team IN ('home', 'away', 'both'));

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_two_up_leader_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_two_up_leader_check CHECK (two_up_first_leader IS NULL OR two_up_first_leader IN ('home', 'away'));

CREATE INDEX IF NOT EXISTS matches_hot_idx ON matches (is_hot_match) WHERE is_hot_match;

ALTER TABLE bet_legs
  ADD COLUMN IF NOT EXISTS two_up_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS two_up_attempt INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS two_up_paid_amount BIGINT;

DO $drop$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'bets'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE bets DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$drop$;

ALTER TABLE bets
  ADD CONSTRAINT bets_status_check CHECK (status IN ('open', 'won', 'lost', 'void', 'cashout'));

CREATE TABLE IF NOT EXISTS match_feed_cache (
  match_id INT PRIMARY KEY REFERENCES matches (id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_runs (
  id BIGSERIAL PRIMARY KEY,
  job TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION grade_selection(
  p_code TEXT,
  p_selection TEXT,
  p_line NUMERIC,
  p_home INT,
  p_away INT
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $grade$
DECLARE
  v_code TEXT := lower(trim(coalesce(p_code, '')));
  v_sel TEXT := lower(trim(coalesce(p_selection, '')));
  v_total INT := p_home + p_away;
  v_line NUMERIC := p_line;
  v_num TEXT;
  v_h INT;
  v_a INT;
  v_adj NUMERIC;
  v_side TEXT;
BEGIN
  IF v_code LIKE '%handicap%' THEN
    v_num := substring(p_selection FROM '([+-]?[0-9]+\.?[0-9]*)');
    IF v_sel LIKE 'home%' OR v_sel = '1' OR v_sel LIKE '1 %' THEN
      v_side := 'home';
    ELSIF v_sel LIKE 'draw%' OR v_sel = 'x' OR v_sel LIKE 'x %' THEN
      v_side := 'draw';
    ELSIF v_sel LIKE 'away%' OR v_sel = '2' OR v_sel LIKE '2 %' THEN
      v_side := 'away';
    ELSE
      RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
    END IF;
    IF v_code LIKE '%2-way%' OR v_code LIKE '%asian%' THEN
      IF p_line IS NOT NULL THEN
        v_line := p_line;
      ELSIF v_num IS NOT NULL AND v_num <> '' THEN
        v_line := v_num::numeric;
        IF v_side = 'away' THEN
          v_line := -v_line;
        END IF;
      ELSE
        v_line := 0;
      END IF;
      v_adj := p_home + v_line;
      IF v_side = 'home' THEN
        IF v_adj > p_away THEN RETURN 'won'; ELSIF v_adj < p_away THEN RETURN 'lost'; ELSE RETURN 'void'; END IF;
      ELSIF v_side = 'away' THEN
        IF v_adj < p_away THEN RETURN 'won'; ELSIF v_adj > p_away THEN RETURN 'lost'; ELSE RETURN 'void'; END IF;
      ELSE
        RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF v_num IS NOT NULL AND v_num <> '' THEN
        v_line := v_num::numeric;
      ELSIF v_line IS NULL THEN
        v_line := 0;
      END IF;
      v_adj := p_home + v_line;
      IF v_side = 'home' THEN
        RETURN CASE WHEN v_adj > p_away THEN 'won' ELSE 'lost' END;
      ELSIF v_side = 'draw' THEN
        RETURN CASE WHEN v_adj = p_away THEN 'won' ELSE 'lost' END;
      ELSE
        RETURN CASE WHEN v_adj < p_away THEN 'won' ELSE 'lost' END;
      END IF;
    END IF;
  ELSIF v_code LIKE 'correct score%' OR v_code = 'exact score' OR v_code = 'cs' THEN
    v_num := substring(p_selection FROM '([0-9]+)\s*[-:]\s*([0-9]+)');
    v_h := substring(p_selection FROM '([0-9]+)[[:space:]]*[-:]')::int;
    v_a := substring(p_selection FROM '[-:][[:space:]]*([0-9]+)')::int;
    IF v_h IS NULL OR v_a IS NULL THEN
      RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
    END IF;
    RETURN CASE WHEN p_home = v_h AND p_away = v_a THEN 'won' ELSE 'lost' END;
  ELSIF v_code LIKE 'draw no bet%' OR v_code = 'dnb' THEN
    IF p_home = p_away THEN
      RETURN 'void';
    ELSIF v_sel IN ('1', 'home') OR v_sel LIKE 'home%' THEN
      RETURN CASE WHEN p_home > p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('2', 'away') OR v_sel LIKE 'away%' THEN
      RETURN CASE WHEN p_away > p_home THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code LIKE 'odd/even%' OR v_code LIKE 'odd even%' OR v_code = 'goals odd/even' THEN
    IF v_sel = 'odd' THEN
      RETURN CASE WHEN v_total % 2 = 1 THEN 'won' ELSE 'lost' END;
    ELSIF v_sel = 'even' THEN
      RETURN CASE WHEN v_total % 2 = 0 THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code = 'home/away' OR v_code LIKE 'home/away %' THEN
    IF p_home = p_away THEN
      RETURN 'lost';
    ELSIF v_sel IN ('1', 'home') OR v_sel LIKE 'home%' THEN
      RETURN CASE WHEN p_home > p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('2', 'away') OR v_sel LIKE 'away%' THEN
      RETURN CASE WHEN p_away > p_home THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code LIKE 'exact goals%' OR v_code LIKE 'total goals exact%' THEN
    v_num := substring(p_selection FROM '([0-9]+)');
    IF v_num IS NULL OR v_num = '' THEN
      RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
    END IF;
    IF v_sel LIKE '%+' THEN
      RETURN CASE WHEN v_total >= v_num::int THEN 'won' ELSE 'lost' END;
    ELSE
      RETURN CASE WHEN v_total = v_num::int THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code LIKE '1x2%' OR v_code IN ('match winner', 'fulltime result', '2up') OR v_code LIKE '2up %' OR v_code LIKE '2up|%' THEN
    IF v_sel IN ('1', 'home') THEN
      RETURN CASE WHEN p_home > p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('x', 'draw') THEN
      RETURN CASE WHEN p_home = p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('2', 'away') THEN
      RETURN CASE WHEN p_away > p_home THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code LIKE 'btts%' OR v_code LIKE 'both teams%' THEN
    IF v_sel IN ('yes', 'btts_yes') THEN
      RETURN CASE WHEN p_home > 0 AND p_away > 0 THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('no', 'btts_no') THEN
      RETURN CASE WHEN p_home = 0 OR p_away = 0 THEN 'won' ELSE 'lost' END;
    END IF;
  ELSIF v_code LIKE 'over/under%' OR v_code LIKE 'goals over%' OR v_code = 'ou' THEN
    v_num := substring(p_selection FROM '([0-9]+\.?[0-9]*)');
    IF v_num IS NOT NULL AND v_num <> '' THEN
      v_line := v_num::numeric;
    ELSIF v_line IS NULL THEN
      v_line := 2.5;
    END IF;
    IF v_sel LIKE 'over%' THEN
      IF v_total > v_line THEN RETURN 'won'; ELSIF v_total < v_line THEN RETURN 'lost'; ELSE RETURN 'void'; END IF;
    ELSIF v_sel LIKE 'under%' THEN
      IF v_total < v_line THEN RETURN 'won'; ELSIF v_total > v_line THEN RETURN 'lost'; ELSE RETURN 'void'; END IF;
    END IF;
  ELSIF v_code LIKE 'double chance%' OR v_code = 'dc' THEN
    IF v_sel IN ('1x', 'home/draw', 'home or draw', 'dc_1x') THEN
      RETURN CASE WHEN p_home >= p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('12', 'home/away', 'home or away', 'dc_12') THEN
      RETURN CASE WHEN p_home <> p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('x2', 'draw/away', 'draw or away', 'dc_x2') THEN
      RETURN CASE WHEN p_away >= p_home THEN 'won' ELSE 'lost' END;
    END IF;
  END IF;
  RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
END;
$grade$;

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
           b.user_id, b.stake_tzs, b.status AS bet_status, b.potential_payout_tzs
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
        v_payout := round(v_leg.stake_tzs * v_leg.odds_at_placement)::bigint;
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
            v_payout := round(v_leg.stake_tzs * v_product)::bigint;
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
  v_value BIGINT;
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
    ELSE
      RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  v_value := floor(v_bet.stake_tzs * v_product * (10000 - p_margin_bps) / 10000.0)::bigint;
  IF v_value IS NULL OR v_value < 1 THEN
    RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_value;
END;
$quote$;

CREATE OR REPLACE FUNCTION cashout_bet_atomic(
  p_user_id UUID,
  p_bet_id UUID,
  p_margin_bps INT,
  p_expected BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $cash$
DECLARE
  v_bet bets%ROWTYPE;
  v_value BIGINT;
  v_credit JSONB;
BEGIN
  SELECT * INTO v_bet FROM bets WHERE id = p_bet_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bet_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_bet.status = 'cashout' THEN
    SELECT amount_tzs INTO v_value FROM ledger_entries WHERE idempotency_key = 'cashout-' || p_bet_id::text;
    RETURN jsonb_build_object('idempotent', true, 'credited_tzs', COALESCE(v_value, 0), 'status', 'cashout');
  END IF;
  IF v_bet.status <> 'open' THEN
    RAISE EXCEPTION 'cashout_closed' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1
    FROM bet_legs l
    JOIN odds o ON o.id = l.odds_id
   WHERE l.bet_id = p_bet_id
     AND l.status = 'open'
   FOR UPDATE OF o;
  v_value := cashout_value(p_user_id, p_bet_id, p_margin_bps);
  IF p_expected IS NULL OR p_expected <> v_value THEN
    RAISE EXCEPTION 'cashout_changed' USING ERRCODE = 'P0001';
  END IF;
  v_credit := wallet_credit(
    p_user_id, v_value, 'bet_win',
    'cashout-' || p_bet_id::text,
    'cash', 'bet', p_bet_id, 'cashout', NULL
  );
  UPDATE bets SET status = 'cashout', settled_at = now() WHERE id = p_bet_id;
  UPDATE bet_legs SET status = 'void' WHERE bet_id = p_bet_id AND status = 'open';
  INSERT INTO audit_log (actor_user_id, actor, action, payload)
  VALUES (p_user_id, 'player', 'bet.cashout', jsonb_build_object('bet_id', p_bet_id, 'credited_tzs', v_value, 'margin_bps', p_margin_bps));
  RETURN jsonb_build_object(
    'idempotent', false,
    'credited_tzs', v_value,
    'balance_tzs', (v_credit->>'balance_tzs')::bigint,
    'status', 'cashout'
  );
END;
$cash$;

REVOKE ALL ON FUNCTION grade_selection(TEXT, TEXT, NUMERIC, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_two_up(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cashout_value(UUID, UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cashout_bet_atomic(UUID, UUID, INT, BIGINT) FROM PUBLIC;

UPDATE matches
   SET is_hot_match = true
 WHERE home = 'Simba SC' AND away = 'Yanga SC' AND source = 'manual';

UPDATE matches
   SET two_up_enabled = true,
       two_up_home_odds = 1.90,
       two_up_draw_odds = 3.40,
       two_up_away_odds = 4.10,
       two_up_team = 'both'
 WHERE home = 'Arsenal' AND away = 'Chelsea' AND source = 'manual';

INSERT INTO markets (match_id, name, code, line)
SELECT m.id, '2UP', '2UP', NULL
  FROM matches m
 WHERE m.home = 'Arsenal' AND m.away = 'Chelsea' AND m.source = 'manual'
   AND NOT EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.code = '2UP');

INSERT INTO odds (market_id, selection, price)
SELECT mk.id, s.selection, s.price
  FROM markets mk
  JOIN matches m ON m.id = mk.match_id
  JOIN (VALUES ('1', 1.90), ('X', 3.40), ('2', 4.10)) AS s(selection, price) ON true
 WHERE m.home = 'Arsenal' AND m.away = 'Chelsea' AND m.source = 'manual' AND mk.code = '2UP'
ON CONFLICT (market_id, selection) DO NOTHING;

INSERT INTO markets (match_id, name, code, line)
SELECT m.id, v.code, v.code, v.line
  FROM matches m
  JOIN (VALUES
    ('Correct Score', NULL::numeric),
    ('3-Way Handicap -1', -1),
    ('2-Way Handicap -0.5', -0.5),
    ('Draw No Bet', NULL),
    ('Odd/Even', NULL),
    ('Home/Away', NULL),
    ('Exact Goals', NULL)
  ) AS v(code, line) ON true
 WHERE m.home = 'Simba SC' AND m.away = 'Yanga SC' AND m.source = 'manual'
   AND NOT EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.code = v.code);

INSERT INTO odds (market_id, selection, price)
SELECT mk.id, s.selection, s.price
  FROM markets mk
  JOIN matches m ON m.id = mk.match_id
  JOIN (VALUES
    ('Correct Score', '1-0', 6.50),
    ('Correct Score', '2-0', 8.00),
    ('Correct Score', '2-1', 9.50),
    ('Correct Score', '0-0', 9.00),
    ('Correct Score', '1-1', 6.00),
    ('Correct Score', '0-1', 11.00),
    ('3-Way Handicap -1', 'Home -1', 3.40),
    ('3-Way Handicap -1', 'Draw -1', 3.30),
    ('3-Way Handicap -1', 'Away -1', 2.05),
    ('2-Way Handicap -0.5', 'Home -0.5', 1.80),
    ('2-Way Handicap -0.5', 'Away +0.5', 2.00),
    ('Draw No Bet', '1', 1.40),
    ('Draw No Bet', '2', 2.80),
    ('Odd/Even', 'Odd', 1.90),
    ('Odd/Even', 'Even', 1.90),
    ('Home/Away', '1', 1.55),
    ('Home/Away', '2', 2.40),
    ('Exact Goals', '0', 9.00),
    ('Exact Goals', '1', 4.20),
    ('Exact Goals', '2', 3.40),
    ('Exact Goals', '3+', 2.60)
  ) AS s(code, selection, price) ON s.code = mk.code
 WHERE m.home = 'Simba SC' AND m.away = 'Yanga SC' AND m.source = 'manual'
ON CONFLICT (market_id, selection) DO NOTHING;

INSERT INTO match_feed_cache (match_id, payload, fetched_at)
SELECT m.id,
       jsonb_build_object(
         'source', 'sample',
         'note', 'Mfano wa ukurasa. Weka ufunguo wa API-Football ili kupata matukio ya moja kwa moja.',
         'events', jsonb_build_array(
           jsonb_build_object('minute', 23, 'team', 'home', 'type', 'Goal', 'detail', 'Normal Goal', 'player', 'Kibwana'),
           jsonb_build_object('minute', 41, 'team', 'away', 'type', 'Card', 'detail', 'Yellow Card', 'player', 'Mwamnyeto')
         ),
         'lineups', jsonb_build_object(
           'homeFormation', '4-3-3',
           'awayFormation', '4-4-2',
           'home', jsonb_build_array('Kibwana', 'Hussein', 'Kapombe', 'Bocco'),
           'away', jsonb_build_array('Mwamnyeto', 'Aziz', 'Yusuph', 'Salum')
         ),
         'h2h', jsonb_build_array(
           jsonb_build_object('date', '2025-05-10', 'home', 'Simba SC', 'away', 'Yanga SC', 'hs', 2, 'as', 1)
         ),
         'injuries', jsonb_build_array(
           jsonb_build_object('team', 'away', 'player', 'Kibwana J', 'reason', 'Knee')
         ),
         'last', jsonb_build_object(
           'home', jsonb_build_array(jsonb_build_object('date', '2025-10-01', 'opponent', 'Azam FC', 'hs', 1, 'as', 0)),
           'away', jsonb_build_array(jsonb_build_object('date', '2025-10-02', 'opponent', 'Singida BS', 'hs', 0, 'as', 0))
         ),
         'stats', jsonb_build_object('homePossession', 58, 'awayPossession', 42)
       ),
       now()
  FROM matches m
 WHERE m.home = 'Simba SC' AND m.away = 'Yanga SC' AND m.source = 'manual'
ON CONFLICT (match_id) DO NOTHING;
