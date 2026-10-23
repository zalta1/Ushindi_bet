-- A deposit starts as a pending request. Step 3 will move it to the ledger after the provider confirms the PIN.
-- Nothing in this table changes wallets.balance_tzs.

CREATE TABLE deposit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  phone TEXT NOT NULL CHECK (phone ~ '^\+255[67][0-9]{8}$'),
  amount_tzs BIGINT NOT NULL CHECK (amount_tzs > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  provider TEXT NOT NULL DEFAULT 'sandbox',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX deposit_requests_user_idx ON deposit_requests (user_id, created_at DESC);
