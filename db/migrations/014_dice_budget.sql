-- PesaBetPro dice budget. One row, locked with the ledger transaction.
-- forced marks a roll that came from generateDiceRoll instead of the seed hash.

ALTER TABLE dice_bets ADD COLUMN forced BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE dice_budget (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  budget_tzs BIGINT NOT NULL DEFAULT 25000 CHECK (budget_tzs >= 0),
  total_bets_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_bets_tzs >= 0),
  total_payouts_tzs BIGINT NOT NULL DEFAULT 0 CHECK (total_payouts_tzs >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO dice_budget (id) VALUES (TRUE);
