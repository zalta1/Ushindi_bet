-- Zungusha. One spin, one fixed prize. The stake is the cost of the spin.
-- The budget row is separate from Aviator, Dice, Mines, Mayan, and Penalty.
-- While the switch is off, the prize is a weight draw. While it is on, a draw
-- under the loss rate lands on an active LOST prize before that weight draw.
-- The published zungusha-spin function and the live reward rows are not in the
-- client. These rows use the fields their admin edits (label, amount, segments,
-- weight, colour, LOST). The weights pay about 90 percent of a 500 TSh spin.
-- An admin can replace every row.

CREATE TABLE zungusha_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO zungusha_budget (id) VALUES (TRUE);

CREATE TABLE zungusha_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  amount_tzs BIGINT NOT NULL CHECK (amount_tzs >= 0 AND amount_tzs <= 50000000),
  segment_count INTEGER NOT NULL CHECK (segment_count BETWEEN 1 AND 48),
  weight NUMERIC(14, 6) NOT NULL CHECK (weight >= 0 AND weight <= 1000000),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_lost BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL
);

INSERT INTO zungusha_rewards (reward_key, label, amount_tzs, segment_count, weight, color, is_lost, display_order) VALUES
  ('lost', 'LOST', 0, 6, 3572, '#4b5563', TRUE, 1),
  ('tsh-200', '200', 200, 3, 2000, '#22c55e', FALSE, 2),
  ('tsh-500', '500', 500, 2, 4200, '#3b82f6', FALSE, 3),
  ('tsh-1000', '1000', 1000, 2, 200, '#a855f7', FALSE, 4),
  ('tsh-5000', '5000', 5000, 1, 20, '#f59e0b', FALSE, 5),
  ('tsh-20000', '20000', 20000, 1, 5, '#ef4444', FALSE, 6),
  ('tsh-50000', '50000', 50000, 1, 2, '#ec4899', FALSE, 7),
  ('iphone', 'iPhone 17 Pro Max', 1500000, 1, 1, '#eab308', FALSE, 8);

CREATE TABLE zungusha_spins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reward_id UUID REFERENCES zungusha_rewards (id) ON DELETE SET NULL,
  stake_tzs BIGINT NOT NULL CHECK (stake_tzs > 0),
  reward_label TEXT NOT NULL,
  reward_color TEXT NOT NULL,
  amount_tzs BIGINT NOT NULL CHECK (amount_tzs >= 0),
  payout_tzs BIGINT NOT NULL CHECK (payout_tzs >= 0),
  is_lost BOOLEAN NOT NULL,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  weight NUMERIC(14, 6) NOT NULL,
  forced BOOLEAN NOT NULL DEFAULT FALSE,
  roll NUMERIC(12, 10) NOT NULL,
  server_seed TEXT NOT NULL,
  hash TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  client_seed TEXT NOT NULL,
  client_ref TEXT NOT NULL UNIQUE CHECK (char_length(client_ref) BETWEEN 8 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX zungusha_spins_user_idx ON zungusha_spins (user_id, created_at DESC);
CREATE INDEX zungusha_spins_winners_idx ON zungusha_spins (created_at DESC) WHERE payout_tzs > 0;
