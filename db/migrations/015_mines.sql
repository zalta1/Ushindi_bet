-- Mines: the server places the mines. The client never sends positions.
-- Stake and cashout move through the ledger in the same transaction as the budget counters.

CREATE TABLE mines_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO mines_budget (id) VALUES (TRUE);

CREATE TABLE mines_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  mine_count INTEGER NOT NULL CHECK (mine_count BETWEEN 1 AND 24),
  mines INTEGER[] NOT NULL CHECK (cardinality(mines) = mine_count),
  revealed INTEGER[] NOT NULL DEFAULT '{}',
  multiplier NUMERIC(8, 2) NOT NULL DEFAULT 1,
  payout_tzs BIGINT NOT NULL DEFAULT 0 CHECK (payout_tzs >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'lost')),
  rtp_bps INTEGER NOT NULL,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX mines_one_active_idx ON mines_bets (user_id) WHERE status = 'active';
CREATE INDEX mines_bets_user_idx ON mines_bets (user_id, created_at DESC);

CREATE TABLE mines_actions (
  bet_id UUID NOT NULL REFERENCES mines_bets (id) ON DELETE CASCADE,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('reveal', 'cashout')),
  cell INTEGER CHECK (cell IS NULL OR cell BETWEEN 0 AND 24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bet_id, client_ref)
);
