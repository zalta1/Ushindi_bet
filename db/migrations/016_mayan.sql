-- Mayan Gold. One budget row, separate from Aviator.
-- PesaBetPro stores this game on the Aviator budget keys. Ushindi does not,
-- so a Mayan spin cannot rewrite an Aviator round.
-- The wheel index is generateWheelIndex. There is no seed.

CREATE TABLE mayan_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO mayan_budget (id) VALUES (TRUE);

CREATE TABLE mayan_spins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  bets JSONB NOT NULL,
  win_idx INTEGER NOT NULL CHECK (win_idx BETWEEN 0 AND 23),
  multiplier NUMERIC(8, 2) NOT NULL,
  payout_tzs BIGINT NOT NULL DEFAULT 0 CHECK (payout_tzs >= 0),
  won BOOLEAN NOT NULL,
  loss_rate NUMERIC(4, 2) NOT NULL,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mayan_spins_user_idx ON mayan_spins (user_id, created_at DESC);
