-- Ushindi Bet initial schema.
-- Amounts are BIGINT whole shillings (TZS). There is no fractional unit.
-- ledger_entries is the source of truth for money. wallets.balance_tzs is the
-- locked cache updated in the same transaction as each ledger insert.
-- Later wallet and bet HTTP handlers must call wallet_credit, wallet_debit,
-- and place_bet_atomic rather than updating balances themselves.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_role AS ENUM (
  'player',
  'super_admin',
  'admin',
  'finance',
  'risk',
  'support',
  'marketing',
  'compliance'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  dob DATE NOT NULL,
  role account_role NOT NULL DEFAULT 'player',
  kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
  rg_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  self_excluded_until TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_tz CHECK (phone ~ '^\+255[67][0-9]{8}$'),
  CONSTRAINT users_full_name_len CHECK (char_length(full_name) BETWEEN 2 AND 80)
);

CREATE INDEX users_role_idx ON users (role);

CREATE OR REPLACE FUNCTION users_require_adult() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Session time zone is Africa/Dar_es_Salaam (set on each connection).
  IF NEW.dob > (CURRENT_DATE - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'underage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_adult
  BEFORE INSERT OR UPDATE OF dob ON users
  FOR EACH ROW EXECUTE FUNCTION users_require_adult();

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users (id),
  balance_tzs BIGINT NOT NULL DEFAULT 0 CHECK (balance_tzs >= 0),
  bonus_balance_tzs BIGINT NOT NULL DEFAULT 0 CHECK (bonus_balance_tzs >= 0),
  currency TEXT NOT NULL DEFAULT 'TZS' CHECK (currency = 'TZS'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only money ledger. amount_tzs is always positive; direction says
-- whether the wallet cache was credited or debited. idempotency_key makes
-- retries safe. Application code must not UPDATE or DELETE these rows.
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets (id),
  user_id UUID NOT NULL REFERENCES users (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'deposit', 'withdraw', 'bet_stake', 'bet_win', 'bonus', 'refund', 'adjustment'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_tzs BIGINT NOT NULL CHECK (amount_tzs > 0),
  balance_after_tzs BIGINT NOT NULL CHECK (balance_after_tzs >= 0),
  bonus_after_tzs BIGINT NOT NULL CHECK (bonus_after_tzs >= 0),
  bucket TEXT NOT NULL CHECK (bucket IN ('cash', 'bonus')),
  idempotency_key TEXT NOT NULL UNIQUE,
  reference_type TEXT,
  reference_id UUID,
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_user_idx ON ledger_entries (user_id, created_at);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE matches (
  id SERIAL PRIMARY KEY,
  sport TEXT,
  league TEXT,
  home TEXT,
  away TEXT,
  kickoff_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'upcoming',
  home_score INT NOT NULL DEFAULT 0,
  away_score INT NOT NULL DEFAULT 0
);

CREATE TABLE markets (
  id SERIAL PRIMARY KEY,
  match_id INT REFERENCES matches (id),
  name TEXT
);

CREATE TABLE odds (
  id SERIAL PRIMARY KEY,
  market_id INT REFERENCES markets (id),
  selection TEXT,
  price NUMERIC(8, 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  combined_odds NUMERIC(18, 6) NOT NULL CHECK (combined_odds > 1),
  potential_payout_tzs BIGINT NOT NULL CHECK (potential_payout_tzs >= stake_tzs),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  idempotency_key TEXT NOT NULL UNIQUE,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX bets_user_idx ON bets (user_id, placed_at);

CREATE TABLE bet_legs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id UUID NOT NULL REFERENCES bets (id),
  match_id INT,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds_at_placement NUMERIC(12, 4) NOT NULL CHECK (odds_at_placement > 1)
);

CREATE TABLE crash_rounds (
  id SERIAL PRIMARY KEY,
  server_seed_hash TEXT NOT NULL,
  server_seed TEXT,
  client_seed TEXT,
  nonce INT,
  crash_multiplier NUMERIC(8, 2),
  rtp_bps INT NOT NULL DEFAULT 9700,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kyc_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  doc_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE promotions (
  id SERIAL PRIMARY KEY,
  title_sw TEXT,
  title_en TEXT,
  wagering_multiplier INT NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor TEXT,
  action TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_idx ON audit_log (created_at);

CREATE TABLE auth_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  phone TEXT,
  event TEXT NOT NULL CHECK (event IN (
    'register', 'login_success', 'login_failure', 'logout', 'lockout', 'password_change'
  )),
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_events_created_idx ON auth_events (created_at);

CREATE TABLE official_results (
  match_id INT PRIMARY KEY,
  source TEXT,
  home_score INT,
  away_score INT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER ledger_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER auth_events_no_update
  BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
