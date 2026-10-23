-- One staff role. PesaBetPro's extra roles were not used to hide sections,
-- and the owner asked for the same: admin or player.
-- Existing super_admin, finance, risk, support, marketing, and compliance
-- accounts become admin. The owner's phone is included explicitly so that
-- account is admin even if its previous role was already changed.

UPDATE users SET role = 'admin', updated_at = now() WHERE role <> 'player';

UPDATE users SET role = 'admin', updated_at = now() WHERE phone = '+255743500257';

ALTER TABLE users ALTER COLUMN role DROP DEFAULT;

CREATE TYPE account_role_new AS ENUM ('player', 'admin');

ALTER TABLE users
  ALTER COLUMN role TYPE account_role_new
  USING (
    CASE
      WHEN role::text = 'player' THEN 'player'::account_role_new
      ELSE 'admin'::account_role_new
    END
  );

DROP TYPE account_role;

ALTER TYPE account_role_new RENAME TO account_role;

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'player'::account_role;
