-- Penalty. One shot, one zone. The goal is roll < win_chance.
-- The budget row is separate from Aviator, Dice, Mines, and Mayan.
-- The kick does not read the budget loss rate. The zone win chance is the payout.

CREATE TABLE penalty_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO penalty_budget (id) VALUES (TRUE);

CREATE TABLE penalty_zones (
  zone_key TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  multiplier NUMERIC(8, 2) NOT NULL CHECK (multiplier >= 1 AND multiplier <= 1000),
  win_chance NUMERIC(6, 4) NOT NULL CHECK (win_chance >= 0 AND win_chance <= 0.95),
  display_order INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO penalty_zones (zone_key, label, multiplier, win_chance, display_order) VALUES
  ('top-left', 'Juu Kushoto', 5, 0.1800, 1),
  ('top-center', 'Juu Katikati', 10, 0.0900, 2),
  ('top-right', 'Juu Kulia', 5, 0.1800, 3),
  ('mid-left', 'Kati Kushoto', 10, 0.0900, 4),
  ('mid-center', 'Katikati', 20, 0.0450, 5),
  ('mid-right', 'Kati Kulia', 10, 0.0900, 6),
  ('bottom-left', 'Chini Kushoto', 5, 0.1800, 7),
  ('bottom-center', 'Chini Katikati', 35, 0.0260, 8),
  ('bottom-right', 'Chini Kulia', 5, 0.1800, 9);

CREATE TABLE penalty_shots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  zone_key TEXT NOT NULL,
  keeper_zone TEXT NOT NULL,
  multiplier NUMERIC(8, 2) NOT NULL,
  win_chance NUMERIC(6, 4) NOT NULL,
  roll NUMERIC(12, 10) NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('goal', 'saved', 'miss')),
  payout_tzs BIGINT NOT NULL CHECK (payout_tzs >= 0),
  server_seed TEXT NOT NULL,
  hash TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX penalty_shots_user_idx ON penalty_shots (user_id, created_at DESC);
