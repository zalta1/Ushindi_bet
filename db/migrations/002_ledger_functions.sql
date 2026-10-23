-- Atomic money movement. Each function runs as one statement, so the ledger
-- insert and the wallet cache update commit or roll back together.
-- Callers must pass a new idempotency key per operation. Replaying the same
-- key returns the original result and does not move money twice.

CREATE OR REPLACE FUNCTION assert_idempotency_key(p_key TEXT) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 OR length(p_key) > 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION wallet_credit(
  p_user_id UUID,
  p_amount BIGINT,
  p_entry_type TEXT,
  p_idempotency_key TEXT,
  p_bucket TEXT DEFAULT 'cash',
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id UUID DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_provider_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_existing ledger_entries%ROWTYPE;
  v_balance BIGINT;
  v_bonus BIGINT;
  v_entry_id UUID;
BEGIN
  PERFORM assert_idempotency_key(p_idempotency_key);
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive' USING ERRCODE = '22023';
  END IF;
  IF p_bucket NOT IN ('cash', 'bonus') THEN
    RAISE EXCEPTION 'invalid_bucket' USING ERRCODE = '22023';
  END IF;
  IF p_entry_type NOT IN ('deposit', 'bet_win', 'bonus', 'refund', 'adjustment') THEN
    RAISE EXCEPTION 'invalid_entry_type' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'credit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'credit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END IF;

  v_balance := v_wallet.balance_tzs;
  v_bonus := v_wallet.bonus_balance_tzs;
  IF p_bucket = 'cash' THEN
    v_balance := v_balance + p_amount;
  ELSE
    v_bonus := v_bonus + p_amount;
  END IF;

  BEGIN
    INSERT INTO ledger_entries (
      wallet_id, user_id, entry_type, direction, amount_tzs,
      balance_after_tzs, bonus_after_tzs, bucket, idempotency_key,
      reference_type, reference_id, provider, provider_ref
    ) VALUES (
      v_wallet.id, p_user_id, p_entry_type, 'credit', p_amount,
      v_balance, v_bonus, p_bucket, p_idempotency_key,
      p_reference_type, p_reference_id, p_provider, p_provider_ref
    ) RETURNING id INTO v_entry_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'credit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END;

  UPDATE wallets
     SET balance_tzs = v_balance,
         bonus_balance_tzs = v_bonus,
         updated_at = now()
   WHERE id = v_wallet.id;

  RETURN jsonb_build_object(
    'idempotent', false,
    'ledger_id', v_entry_id,
    'balance_tzs', v_balance,
    'bonus_balance_tzs', v_bonus
  );
END;
$$;

CREATE OR REPLACE FUNCTION wallet_debit(
  p_user_id UUID,
  p_amount BIGINT,
  p_entry_type TEXT,
  p_idempotency_key TEXT,
  p_bucket TEXT DEFAULT 'cash',
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id UUID DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_provider_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_existing ledger_entries%ROWTYPE;
  v_balance BIGINT;
  v_bonus BIGINT;
  v_entry_id UUID;
BEGIN
  PERFORM assert_idempotency_key(p_idempotency_key);
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive' USING ERRCODE = '22023';
  END IF;
  IF p_bucket NOT IN ('cash', 'bonus') THEN
    RAISE EXCEPTION 'invalid_bucket' USING ERRCODE = '22023';
  END IF;
  IF p_entry_type NOT IN ('withdraw', 'bet_stake', 'adjustment') THEN
    RAISE EXCEPTION 'invalid_entry_type' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'debit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'debit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END IF;

  v_balance := v_wallet.balance_tzs;
  v_bonus := v_wallet.bonus_balance_tzs;
  IF p_bucket = 'cash' THEN
    IF v_wallet.balance_tzs < p_amount THEN
      RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = 'P0001';
    END IF;
    v_balance := v_wallet.balance_tzs - p_amount;
  ELSE
    IF v_wallet.bonus_balance_tzs < p_amount THEN
      RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = 'P0001';
    END IF;
    v_bonus := v_wallet.bonus_balance_tzs - p_amount;
  END IF;

  BEGIN
    INSERT INTO ledger_entries (
      wallet_id, user_id, entry_type, direction, amount_tzs,
      balance_after_tzs, bonus_after_tzs, bucket, idempotency_key,
      reference_type, reference_id, provider, provider_ref
    ) VALUES (
      v_wallet.id, p_user_id, p_entry_type, 'debit', p_amount,
      v_balance, v_bonus, p_bucket, p_idempotency_key,
      p_reference_type, p_reference_id, p_provider, p_provider_ref
    ) RETURNING id INTO v_entry_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM ledger_entries WHERE idempotency_key = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    IF v_existing.user_id <> p_user_id OR v_existing.amount_tzs <> p_amount
       OR v_existing.direction <> 'debit' OR v_existing.bucket <> p_bucket
       OR v_existing.entry_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'idempotent', true,
      'ledger_id', v_existing.id,
      'balance_tzs', v_existing.balance_after_tzs,
      'bonus_balance_tzs', v_existing.bonus_after_tzs
    );
  END;

  UPDATE wallets
     SET balance_tzs = v_balance,
         bonus_balance_tzs = v_bonus,
         updated_at = now()
   WHERE id = v_wallet.id;

  RETURN jsonb_build_object(
    'idempotent', false,
    'ledger_id', v_entry_id,
    'balance_tzs', v_balance,
    'bonus_balance_tzs', v_bonus
  );
END;
$$;

-- Debits the cash stake and inserts the bet plus legs in one transaction.
-- Potential payout is computed here from the leg odds. Callers cannot supply it.
CREATE OR REPLACE FUNCTION place_bet_atomic(
  p_user_id UUID,
  p_stake BIGINT,
  p_legs JSONB,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_at_placement)
    SELECT v_bet_id,
           NULLIF(leg->>'match_id', '')::int,
           leg->>'market',
           leg->>'selection',
           (leg->>'odds')::numeric
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
$$;

REVOKE ALL ON FUNCTION assert_idempotency_key(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_credit(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_debit(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION place_bet_atomic(UUID, BIGINT, JSONB, TEXT) FROM PUBLIC;
