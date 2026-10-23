-- Sign-up is phone and password. Name and date of birth are collected later (KYC).
-- A missing date of birth does not satisfy the 18+ check; the trigger still rejects an underage date.

ALTER TABLE users ALTER COLUMN full_name DROP NOT NULL;
ALTER TABLE users ALTER COLUMN dob DROP NOT NULL;

CREATE OR REPLACE FUNCTION users_require_adult() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dob IS NOT NULL AND NEW.dob > (CURRENT_DATE - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'underage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
