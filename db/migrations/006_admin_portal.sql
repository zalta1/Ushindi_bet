-- Phase A admin portal. Money still moves only through wallet_credit / wallet_debit.
-- Closing an account hides it from login. It does not delete the user or the ledger.

ALTER TABLE users
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN closed_reason TEXT;

ALTER TABLE users
  ADD CONSTRAINT users_closed_reason_len
  CHECK (closed_reason IS NULL OR char_length(closed_reason) BETWEEN 3 AND 200);

CREATE INDEX users_closed_idx ON users (closed_at);

ALTER TABLE sessions
  ADD COLUMN read_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN impersonator_user_id UUID REFERENCES users (id),
  ADD COLUMN impersonation_id UUID;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

CREATE TABLE ledger_notes (
  ledger_id UUID PRIMARY KEY REFERENCES ledger_entries (id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER ledger_notes_no_update
  BEFORE UPDATE OR DELETE ON ledger_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users (id),
  target_user_id UUID NOT NULL REFERENCES users (id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX impersonation_sessions_created_idx ON impersonation_sessions (created_at DESC);

CREATE TABLE force_logout_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users (id),
  target_user_id UUID NOT NULL REFERENCES users (id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER force_logout_no_update
  BEFORE UPDATE OR DELETE ON force_logout_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE wallet_reconciliation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by UUID,
  wallets_checked INT NOT NULL CHECK (wallets_checked >= 0),
  mismatches INT NOT NULL CHECK (mismatches >= 0),
  detail JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE wallet_fraud_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id),
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID
);

CREATE INDEX wallet_fraud_alerts_status_idx ON wallet_fraud_alerts (status, created_at DESC);

CREATE TABLE banners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  image_url TEXT NOT NULL CHECK (char_length(image_url) BETWEEN 1 AND 500),
  link_url TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT banners_link_len CHECK (link_url IS NULL OR char_length(link_url) BETWEEN 1 AND 500)
);

CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_sw TEXT NOT NULL CHECK (char_length(message_sw) BETWEEN 1 AND 280),
  message_en TEXT NOT NULL CHECK (char_length(message_en) BETWEEN 1 AND 280),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users (id),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX notifications_created_idx ON notifications (created_at DESC);

-- Read-only signals. Large adjustments and repeated login failures.
-- Duplicate phones cannot exist: users.phone is unique.
CREATE VIEW fraud_flags AS
WITH jumps AS (
  SELECT user_id,
         MAX(amount_tzs) AS amount_tzs,
         COUNT(*) AS event_count,
         MAX(created_at) AS detected_at
    FROM ledger_entries
   WHERE entry_type = 'adjustment'
     AND created_at > now() - INTERVAL '10 minutes'
   GROUP BY user_id
  HAVING SUM(amount_tzs) >= 100000
),
failures AS (
  SELECT (array_agg(user_id) FILTER (WHERE user_id IS NOT NULL))[1] AS user_id,
         phone,
         COUNT(*) AS event_count,
         MAX(created_at) AS detected_at
    FROM auth_events
   WHERE event = 'login_failure'
     AND created_at > now() - INTERVAL '15 minutes'
     AND phone IS NOT NULL
   GROUP BY phone
  HAVING COUNT(*) >= 5
)
SELECT 'balance_jump'::text AS flag_type,
       j.user_id,
       NULL::text AS phone,
       j.amount_tzs,
       j.event_count,
       j.detected_at
  FROM jumps j
UNION ALL
SELECT 'login_failures'::text,
       f.user_id,
       f.phone,
       NULL::bigint,
       f.event_count,
       f.detected_at
  FROM failures f;

-- Compare the wallet cache with the append-only ledger. Never rewrite balances.
CREATE OR REPLACE FUNCTION wallet_run_reconciliation(p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checked INT;
  v_bad INT;
  v_id UUID;
BEGIN
  SELECT count(*) INTO v_checked FROM wallets;

  INSERT INTO wallet_fraud_alerts (user_id, kind, detail)
  SELECT w.user_id,
         'wallet_mismatch',
         jsonb_build_object(
           'cache_cash', w.balance_tzs,
           'ledger_cash', COALESCE(s.cash, 0),
           'cache_bonus', w.bonus_balance_tzs,
           'ledger_bonus', COALESCE(s.bonus, 0)
         )
    FROM wallets w
    LEFT JOIN (
      SELECT user_id,
             COALESCE(SUM(CASE
               WHEN bucket = 'cash' AND direction = 'credit' THEN amount_tzs
               WHEN bucket = 'cash' AND direction = 'debit' THEN -amount_tzs
               ELSE 0 END), 0) AS cash,
             COALESCE(SUM(CASE
               WHEN bucket = 'bonus' AND direction = 'credit' THEN amount_tzs
               WHEN bucket = 'bonus' AND direction = 'debit' THEN -amount_tzs
               ELSE 0 END), 0) AS bonus
        FROM ledger_entries
       GROUP BY user_id
    ) s ON s.user_id = w.user_id
   WHERE w.balance_tzs <> COALESCE(s.cash, 0)
      OR w.bonus_balance_tzs <> COALESCE(s.bonus, 0);

  GET DIAGNOSTICS v_bad = ROW_COUNT;

  INSERT INTO wallet_reconciliation_log (ran_by, wallets_checked, mismatches, detail)
  VALUES (p_actor, v_checked, v_bad, jsonb_build_object('mismatches', v_bad))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'walletsChecked', v_checked,
    'mismatches', v_bad
  );
END;
$$;

REVOKE ALL ON FUNCTION wallet_run_reconciliation(UUID) FROM PUBLIC;
