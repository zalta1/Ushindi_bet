-- Sports fixtures, markets, and settlement.
-- PesaBetPro reads fixtures and odds from API-Football (api-sports.io),
-- header x-apisports-key. Keys are stored in match_api_keys. Matches with
-- source = 'manual' are bettable when no key is configured.
-- Winnings and refunds move only through wallet_credit inside settle_match_atomic.

CREATE TABLE IF NOT EXISTS sports (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_sw TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  id SERIAL PRIMARY KEY,
  sport_id INT NOT NULL REFERENCES sports (id),
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  UNIQUE (sport_id, name, country)
);

CREATE TABLE IF NOT EXISTS match_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  api_key TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS league_id INT REFERENCES leagues (id),
  ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS minute INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS api_fixture_id BIGINT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS matches_api_fixture_uidx ON matches (api_fixture_id);
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches (status, kickoff_at);

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS line NUMERIC(6, 2);

CREATE UNIQUE INDEX IF NOT EXISTS markets_match_code_uidx ON markets (match_id, code);

ALTER TABLE odds
  ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS odds_market_selection_uidx ON odds (market_id, selection);

ALTER TABLE bet_legs
  ADD COLUMN IF NOT EXISTS odds_id INT REFERENCES odds (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE bet_legs DROP CONSTRAINT IF EXISTS bet_legs_status_check;
ALTER TABLE bet_legs
  ADD CONSTRAINT bet_legs_status_check CHECK (status IN ('open', 'won', 'lost', 'void'));

CREATE INDEX IF NOT EXISTS bet_legs_match_idx ON bet_legs (match_id);
CREATE INDEX IF NOT EXISTS bet_legs_odds_idx ON bet_legs (odds_id);

-- Same signature as 002. Also stores odds_id when the caller sends it.
CREATE OR REPLACE FUNCTION place_bet_atomic(
  p_user_id UUID,
  p_stake BIGINT,
  p_legs JSONB,
  p_idempotency_key TEXT
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
  v_payout := round(p_stake * v_odds)::bigint;
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
    INSERT INTO bets (id, user_id, stake_tzs, combined_odds, potential_payout_tzs, idempotency_key)
    VALUES (v_bet_id, p_user_id, p_stake, v_odds, v_payout, p_idempotency_key);

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
    'balance_tzs', (v_debit->>'balance_tzs')::bigint,
    'bonus_balance_tzs', (v_debit->>'bonus_balance_tzs')::bigint
  );
END;
$place$;

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
BEGIN
  IF v_code LIKE '1x2%' OR v_code IN ('match winner', 'fulltime result') THEN
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
    IF v_sel IN ('1x', 'home/draw', 'home or draw') THEN
      RETURN CASE WHEN p_home >= p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('12', 'home/away', 'home or away') THEN
      RETURN CASE WHEN p_home <> p_away THEN 'won' ELSE 'lost' END;
    ELSIF v_sel IN ('x2', 'draw/away', 'draw or away') THEN
      RETURN CASE WHEN p_away >= p_home THEN 'won' ELSE 'lost' END;
    END IF;
  END IF;
  RAISE EXCEPTION 'unsupported_market' USING ERRCODE = '22023';
END;
$grade$;

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
        v_payout := round(v_bet.stake_tzs * v_product)::bigint;
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

REVOKE ALL ON FUNCTION grade_selection(TEXT, TEXT, NUMERIC, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_match_atomic(INT, INT, INT, UUID, BOOLEAN, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION _seed_odd(
  p_match INT,
  p_code TEXT,
  p_line NUMERIC,
  p_sel TEXT,
  p_price NUMERIC
) RETURNS VOID
LANGUAGE plpgsql
AS $seed$
DECLARE
  v_market INT;
BEGIN
  SELECT id INTO v_market FROM markets WHERE match_id = p_match AND code = p_code;
  IF v_market IS NULL THEN
    INSERT INTO markets (match_id, name, code, line)
    VALUES (p_match, p_code, p_code, p_line)
    RETURNING id INTO v_market;
  END IF;
  INSERT INTO odds (market_id, selection, price)
  VALUES (v_market, p_sel, p_price)
  ON CONFLICT (market_id, selection) DO NOTHING;
END;
$seed$;

DO $do$
DECLARE
  v_sport INT;
  v_tz INT;
  v_epl INT;
  v_sa INT;
  v_simba INT;
  v_arsenal INT;
  v_inter INT;
  v_azam INT;
BEGIN
  INSERT INTO sports (code, name_en, name_sw)
  VALUES ('football', 'Football', 'Mpira wa Miguu')
  ON CONFLICT (code) DO UPDATE SET name_sw = EXCLUDED.name_sw
  RETURNING id INTO v_sport;

  INSERT INTO leagues (sport_id, name, country)
  VALUES (v_sport, 'Ligi Kuu Tanzania', 'Tanzania')
  ON CONFLICT (sport_id, name, country) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_tz;

  INSERT INTO leagues (sport_id, name, country)
  VALUES (v_sport, 'Premier League', 'England')
  ON CONFLICT (sport_id, name, country) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_epl;

  INSERT INTO leagues (sport_id, name, country)
  VALUES (v_sport, 'Serie A', 'Italy')
  ON CONFLICT (sport_id, name, country) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_sa;

  INSERT INTO matches (sport, league, country, home, away, kickoff_at, status, minute, home_score, away_score, source, league_id)
  SELECT 'Football', 'Ligi Kuu Tanzania', 'Tanzania', 'Simba SC', 'Yanga SC', now() - interval '56 minutes', 'live', 56, 1, 0, 'manual', v_tz
  WHERE NOT EXISTS (SELECT 1 FROM matches WHERE home = 'Simba SC' AND away = 'Yanga SC' AND source = 'manual')
  RETURNING id INTO v_simba;
  IF v_simba IS NULL THEN
    SELECT id INTO v_simba FROM matches WHERE home = 'Simba SC' AND away = 'Yanga SC' AND source = 'manual' ORDER BY id LIMIT 1;
  END IF;

  INSERT INTO matches (sport, league, country, home, away, kickoff_at, status, minute, home_score, away_score, source, league_id)
  SELECT 'Football', 'Premier League', 'England', 'Arsenal', 'Chelsea', now() + interval '6 hours', 'upcoming', 0, 0, 0, 'manual', v_epl
  WHERE NOT EXISTS (SELECT 1 FROM matches WHERE home = 'Arsenal' AND away = 'Chelsea' AND source = 'manual')
  RETURNING id INTO v_arsenal;
  IF v_arsenal IS NULL THEN
    SELECT id INTO v_arsenal FROM matches WHERE home = 'Arsenal' AND away = 'Chelsea' AND source = 'manual' ORDER BY id LIMIT 1;
  END IF;

  INSERT INTO matches (sport, league, country, home, away, kickoff_at, status, minute, home_score, away_score, source, league_id)
  SELECT 'Football', 'Serie A', 'Italy', 'Inter', 'Napoli', now() + interval '30 hours', 'upcoming', 0, 0, 0, 'manual', v_sa
  WHERE NOT EXISTS (SELECT 1 FROM matches WHERE home = 'Inter' AND away = 'Napoli' AND source = 'manual')
  RETURNING id INTO v_inter;
  IF v_inter IS NULL THEN
    SELECT id INTO v_inter FROM matches WHERE home = 'Inter' AND away = 'Napoli' AND source = 'manual' ORDER BY id LIMIT 1;
  END IF;

  INSERT INTO matches (sport, league, country, home, away, kickoff_at, status, minute, home_score, away_score, source, league_id)
  SELECT 'Football', 'Ligi Kuu Tanzania', 'Tanzania', 'Azam FC', 'Singida BS', now() + interval '1 day', 'upcoming', 0, 0, 0, 'manual', v_tz
  WHERE NOT EXISTS (SELECT 1 FROM matches WHERE home = 'Azam FC' AND away = 'Singida BS' AND source = 'manual')
  RETURNING id INTO v_azam;
  IF v_azam IS NULL THEN
    SELECT id INTO v_azam FROM matches WHERE home = 'Azam FC' AND away = 'Singida BS' AND source = 'manual' ORDER BY id LIMIT 1;
  END IF;

  PERFORM _seed_odd(v_simba, '1X2', NULL, '1', 1.85);
  PERFORM _seed_odd(v_simba, '1X2', NULL, 'X', 3.40);
  PERFORM _seed_odd(v_simba, '1X2', NULL, '2', 4.20);
  PERFORM _seed_odd(v_simba, 'BTTS', NULL, 'Yes', 1.90);
  PERFORM _seed_odd(v_simba, 'BTTS', NULL, 'No', 1.85);
  PERFORM _seed_odd(v_simba, 'Over/Under', 2.5, 'Over 2.5', 1.95);
  PERFORM _seed_odd(v_simba, 'Over/Under', 2.5, 'Under 2.5', 1.80);
  PERFORM _seed_odd(v_simba, 'Double Chance', NULL, '1X', 1.25);
  PERFORM _seed_odd(v_simba, 'Double Chance', NULL, '12', 1.30);
  PERFORM _seed_odd(v_simba, 'Double Chance', NULL, 'X2', 1.85);

  PERFORM _seed_odd(v_arsenal, '1X2', NULL, '1', 2.10);
  PERFORM _seed_odd(v_arsenal, '1X2', NULL, 'X', 3.30);
  PERFORM _seed_odd(v_arsenal, '1X2', NULL, '2', 3.40);
  PERFORM _seed_odd(v_arsenal, 'BTTS', NULL, 'Yes', 1.72);
  PERFORM _seed_odd(v_arsenal, 'BTTS', NULL, 'No', 2.05);
  PERFORM _seed_odd(v_arsenal, 'Over/Under', 2.5, 'Over 2.5', 1.88);
  PERFORM _seed_odd(v_arsenal, 'Over/Under', 2.5, 'Under 2.5', 1.92);
  PERFORM _seed_odd(v_arsenal, 'Double Chance', NULL, '1X', 1.32);
  PERFORM _seed_odd(v_arsenal, 'Double Chance', NULL, '12', 1.28);
  PERFORM _seed_odd(v_arsenal, 'Double Chance', NULL, 'X2', 1.68);

  PERFORM _seed_odd(v_inter, '1X2', NULL, '1', 1.95);
  PERFORM _seed_odd(v_inter, '1X2', NULL, 'X', 3.25);
  PERFORM _seed_odd(v_inter, '1X2', NULL, '2', 3.90);
  PERFORM _seed_odd(v_inter, 'BTTS', NULL, 'Yes', 1.80);
  PERFORM _seed_odd(v_inter, 'BTTS', NULL, 'No', 1.95);
  PERFORM _seed_odd(v_inter, 'Over/Under', 2.5, 'Over 2.5', 2.02);
  PERFORM _seed_odd(v_inter, 'Over/Under', 2.5, 'Under 2.5', 1.76);
  PERFORM _seed_odd(v_inter, 'Double Chance', NULL, '1X', 1.24);
  PERFORM _seed_odd(v_inter, 'Double Chance', NULL, '12', 1.29);
  PERFORM _seed_odd(v_inter, 'Double Chance', NULL, 'X2', 1.74);

  PERFORM _seed_odd(v_azam, '1X2', NULL, '1', 2.40);
  PERFORM _seed_odd(v_azam, '1X2', NULL, 'X', 3.05);
  PERFORM _seed_odd(v_azam, '1X2', NULL, '2', 2.95);
  PERFORM _seed_odd(v_azam, 'BTTS', NULL, 'Yes', 1.88);
  PERFORM _seed_odd(v_azam, 'BTTS', NULL, 'No', 1.86);
  PERFORM _seed_odd(v_azam, 'Over/Under', 2.5, 'Over 2.5', 2.10);
  PERFORM _seed_odd(v_azam, 'Over/Under', 2.5, 'Under 2.5', 1.70);
  PERFORM _seed_odd(v_azam, 'Double Chance', NULL, '1X', 1.36);
  PERFORM _seed_odd(v_azam, 'Double Chance', NULL, '12', 1.33);
  PERFORM _seed_odd(v_azam, 'Double Chance', NULL, 'X2', 1.48);
END;
$do$;

DROP FUNCTION IF EXISTS _seed_odd(INT, TEXT, NUMERIC, TEXT, NUMERIC);
