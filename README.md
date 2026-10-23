# Ushindi Bet

Tanzanian sportsbook. Accounts and the money ledger use Postgres. Odds, casino, and the deposit button are still sandbox mocks and do not move the ledger.

Swahili is the default language. English and the dark/light theme are unchanged.

## Run

```bash
cp .env.example .env
# Edit .env. Change POSTGRES_PASSWORD and SUPER_ADMIN_PASSWORD before anyone else can reach this machine.
docker compose up --build
```

- Web: http://localhost:5173
- API health: http://localhost:4000/health
- Postgres and Redis listen on localhost only (5432 and 6379)

Sign up with a Tanzanian mobile number and a password of at least 12 characters that includes a letter and a number. Name and date of birth are not required at sign-up. There is no SMS code. After sign-up the app opens the wallet page (`/deposit`). The balance shown for a signed-in user comes from Postgres and starts at 0. The deposit form is still a mock and does not credit the ledger. A rejected sign-up names the field (`fields.password` is `min_length`, `letter_and_digit`, `contains_phone`, or `common`). A locked login includes `minutes`.

The phone in `SUPER_ADMIN_PHONE` is created as `super_admin` on startup when `SUPER_ADMIN_PASSWORD` is set. Sign in with that phone and open `/admin`. Any other account that opens `/admin` sees the admin gate. The API rejects admin calls on the server.

If you previously started the old demo stack, reset the database volume once:

```bash
docker compose down -v
docker compose up --build
```

## Tests

API tests need a local database whose name contains `test`. They refuse to run against any other database.

```bash
# example only — use the password from your local Postgres, not a production password
DATABASE_URL=postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test npm test
```

## Security notes for operators

- Passwords are hashed with Argon2id. Sessions are random tokens in httpOnly cookies. The access cookie lasts 15 minutes. The refresh cookie is rotated and a reused refresh token revokes that browser's session family. A readable CSRF cookie must be echoed in `x-csrf-token` on auth and admin writes.
- Login is rate limited and an account locks for 15 minutes after 5 bad passwords.
- Money is a `BIGINT` count of whole shillings. `wallet_credit`, `wallet_debit`, and `place_bet_atomic` lock the wallet row, write the append-only ledger, and update the cached balance in one database transaction. Do not update `wallets.balance_tzs` from application code.
- Admin actions are appended to `audit_log`. Role checks happen on every request from the database, not from the cookie.
- `.env.example` is a local placeholder. The process will not boot in production while `SUPER_ADMIN_PASSWORD` is still that placeholder. Set `COOKIE_SECURE=true` only behind HTTPS.

Real launch still needs a Gaming Board of Tanzania licence, a payment provider, a licensed odds feed, KYC, and legal review. Those are not in this step.
