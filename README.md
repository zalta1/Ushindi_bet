# Ushindi Bet

Tanzanian sportsbook. Accounts, the money ledger, and sports bets use Postgres. Casino and the deposit button are still sandbox mocks and do not move the ledger.

Swahili is the default language. English and the dark/light theme are unchanged.

## Run

```bash
cp .env.example .env
# Edit .env. Change POSTGRES_PASSWORD and ADMIN_PASSWORD before anyone else can reach this machine.
# SUPER_ADMIN_PHONE and SUPER_ADMIN_PASSWORD still work if the new names are empty.
docker compose up --build
```

- Web: http://localhost:5173
- API health: http://localhost:4000/health
- Postgres and Redis listen on localhost only (5432 and 6379)

Sign up with a Tanzanian mobile number and a password of at least 12 characters that includes a letter and a number. Name and date of birth are not required at sign-up. There is no SMS code. After sign-up the app opens `/deposit`. The balance shown for a signed-in user comes from Postgres and starts at 0. A rejected sign-up names the field (`fields.password` is `min_length`, `letter_and_digit`, `contains_phone`, or `common`). A locked login includes `minutes`.

The deposit page asks for at least `MIN_DEPOSIT_TZS` (30,000 by default). `POST /api/deposits` checks the amount and the phone and stores a pending row. It does not credit the ledger. An admin can change the minimum from `/admin`. That change is stored in Postgres and is still there after a restart.

The phone in `ADMIN_PHONE` (or `SUPER_ADMIN_PHONE`) is created as `admin` on startup when the matching password is set. There is one staff role. Older `super_admin`, finance, risk, support, marketing, and compliance rows are migrated to `admin`. Sign in with that phone and open `/admin`. Any player who opens `/admin` sees the admin gate. The API rejects admin calls from anyone who is not an admin.

`/admin` follows the PesaBetPro section list. Overview counts come from the database. Settings, admin accounts, users, the audit log, wallet reconciliation, banners, announcements, and notifications work. Match API, matches, and bets work too. Payments, games, SMS, and support stay in the menu as coming soon. An admin can add or remove other admins and cannot remove the last one. Balance changes write the ledger with a reason. Closing an account sets `closed_at` and does not delete the user. Impersonation is a short read-only session and is written to the audit log. The phone in `ADMIN_PHONE` is promoted to admin again on startup, so that account can be recovered.

Sports prices are checked again on the server when a bet is placed. The stake goes through `place_bet_atomic`. An admin settles a match by entering the score, or voids it. Either one credits a win or refunds a void through the ledger, once. Doing it again does not move money. PesaBetPro's feed is API-Football (`api-sports.io`, header `x-apisports-key`). Put a key in Match API, or in `API_SPORTS_KEY`. With no key, add matches and odds by hand. Seeded Ligi Kuu, Premier League, and Serie A rows are there so the sports page is not empty.

Correct score, 3-way handicap, Asian handicap, draw no bet, odd/even, home/away, and exact goals settle from the final score. A full-time win still pays the quoted amount. Cash out, when an admin turns it on, pays `floor(stake × each leg's factor × (1 − cashout margin))` with a default margin of 1200 (12%). 2UP pays a single `stake × odds` once a team leads by two before the 88th minute, and a VAR reversal debits that payout. The API can poll API-Football, start matches, advance the live minute, and settle full time. Those jobs stay off until an admin enables them in Settings. Only one worker holds the database lock. `POST /api/settle/:id`, `POST /api/payments/:kind`, and `POST /api/crash/start` require an admin. The old `/v1/uo/*` mock feeds require a signed-in session and do not move money.

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
- `.env.example` is a local placeholder. The process will not boot in production while `ADMIN_PASSWORD` or `SUPER_ADMIN_PASSWORD` is still that placeholder. Set `COOKIE_SECURE=true` only behind HTTPS.
- Admin writes are appended to `audit_log`. The server checks that the caller is an admin on every request. Players cannot open those routes.

Real launch still needs a Gaming Board of Tanzania licence, a payment provider that credits the ledger, a paid API-Football plan if you do not enter fixtures by hand, KYC, and legal review. Deposits and withdrawals are not wired to the ledger in this step.
