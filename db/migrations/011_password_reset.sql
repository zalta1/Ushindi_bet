-- Admin password reset. The temporary password is stored only as a hash.
-- must_change_password forces the next session onto the set-password route.

ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;

-- The original CHECK is inline on auth_events.event. Replace it so a reset
-- can be recorded without storing the password.
ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS auth_events_event_check;

ALTER TABLE auth_events ADD CONSTRAINT auth_events_event_check CHECK (event IN (
  'register',
  'login_success',
  'login_failure',
  'logout',
  'lockout',
  'password_change',
  'password_reset'
));
