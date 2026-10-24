-- Dice: one committed server seed per player, revealed after the roll.
-- The stake and any win move through the ledger in the API transaction.

CREATE TABLE dice_commitments (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dice_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  target INTEGER NOT NULL CHECK (target BETWEEN 1 AND 99),
  side TEXT NOT NULL CHECK (side IN ('under', 'over')),
  roll INTEGER NOT NULL CHECK (roll BETWEEN 1 AND 100),
  multiplier NUMERIC(8, 2) NOT NULL,
  payout_tzs BIGINT NOT NULL CHECK (payout_tzs >= 0),
  won BOOLEAN NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  rtp_bps INTEGER NOT NULL,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX dice_bets_user_idx ON dice_bets (user_id, created_at DESC);
