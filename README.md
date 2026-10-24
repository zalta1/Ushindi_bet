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

`/admin` follows the PesaBetPro section list. Overview counts come from the database. Settings, admin accounts, users, the audit log, wallet reconciliation, banners, announcements, and notifications work. Match API, matches, and bets work too. Payments, casino games, SMS, and support stay in the menu as coming soon. Jackpots are live. An admin can add or remove other admins and cannot remove the last one. Balance changes write the ledger with a reason. Closing an account sets `closed_at` and does not delete the user. Impersonation is a short read-only session and is written to the audit log. The phone in `ADMIN_PHONE` is promoted to admin again on startup, so that account can be recovered.

Password reset does not send an SMS. In Admin → Users, Reset password creates a random temporary password, shows it once, stores only the Argon2id hash, revokes that player's sessions, and sets `must_change_password`. The audit row records the admin, the player, and the time. It does not record the password. The next login can call `/api/auth/me`, refresh, logout, and `POST /api/auth/set-password` only. Every other authenticated request returns `password_change_required` until the player chooses a new password. Forgot password on `/login` explains this in Swahili and English. If Settings has a WhatsApp number, that page links to it (`GET /api/support-contact`).

Sports prices are checked again on the server when a bet is placed. The stake goes through `place_bet_atomic`. An admin settles a match by entering the score, or voids it. Either one credits a win or refunds a void through the ledger, once. Doing it again does not move money. PesaBetPro's feed is API-Football (`api-sports.io`, header `x-apisports-key`). Put a key in Match API, or in `API_SPORTS_KEY`. With no key, add matches and odds by hand. Seeded Ligi Kuu, Premier League, and Serie A rows are there so the sports page is not empty.

Correct score, 3-way handicap, Asian handicap, draw no bet, odd/even, home/away, and exact goals settle from the final score. A full-time win and a 2UP early payout pay `floor(stake × odds × payoutPercentBps / 10000)`. The default is 8800 (88%), editable in admin Settings, and the percent is stored on the bet at placement. The betslip, My Bets, and the place response show that net amount. A void or refund returns 100% of the stake. Cash out, when an admin turns it on, pays `floor(stake × each leg's factor × (1 − cashout margin))` with its own default margin of 1200 (12%), and that value is capped at the win this ticket would pay. 2UP pays once a team leads by two before the 88th minute, and a VAR reversal debits that payout. The API can poll API-Football, start matches, advance the live minute, and settle full time. Those jobs stay off until an admin enables them in Settings. Only one sports worker holds the database lock. `POST /api/settle/:id` and `POST /api/payments/:kind` require an admin. The old `/v1/uo/*` mock feeds require a signed-in session and do not move money.

Dice is a 1–100 roll. Under wins on 1 through the target. Over wins on the target plus one through 100. The price is PesaBetPro's `(99 / winning window) × RTP`, and the default RTP of 9700 basis points is the original 0.97 factor. With the house budget off (the default), the roll is SHA-256 of the server seed, the client seed, and the nonce. The server seed hash is shown before the bet and the seed is revealed after it. With the budget on, the roll is PesaBetPro's `generateDiceRoll`: a crypto draw under the loss rate (0.75 to 0.98, from budget plus stakes minus payouts) forces a losing number, and the other draws are uniform and still not the seed. Those rolls are not provably fair, and the page does not present the seed as proof. The 55% payout cap is the same admin warning PesaBetPro shows; it does not rewrite the roll. The stake is a ledger debit (`dice_stake:` plus the idempotency key) and a win is one credit (`dice_payout:` plus the bet id). The budget counters move in that same transaction, and replaying the key does not move money or the counters again. Admin → Dice sets RTP, stake limits, the win cap, the on/off switch, the budget amount, and the budget switch. Those changes are audited.

Mines is a 5×5 grid. The player picks 1 to 24 mines. The server places them with PesaBetPro's `generateMines` (a uniform draw) and does not send the positions until the round ends. Each safe cell multiplies by the remaining cells over the remaining safe cells, then by RTP. The default RTP of 9700 basis points is the original 0.97 factor. Cash out pays `floor(stake × multiplier)` once, capped by the max win, after at least one gem. Clearing every safe cell pays the same way. A mine pays nothing. The stake is a ledger debit (`mines_stake:` plus the idempotency key) and the payout is one credit (`mines_payout:` plus the bet id). Replaying a start, a reveal, or a cashout does not move money again. One player has one open game. Admin → Mines sets RTP, stake limits, the win cap, the on/off switch, the budget amount, and the budget switch. Those changes are audited. PesaBetPro's published mines generator does not take a loss rate, unlike dice, so the budget counts stakes and payouts and shows the same loss-rate bands and 55% cap, and it does not move a mine onto a clicked cell.

Jackpots are Mega 10 (10 matches) and Power 8 (8 matches). An admin creates one from upcoming fixtures, with a ticket price, a grand prize, tier prizes, and a closing time. A player buys one ticket with a 1X2 pick on every match. The stake is a ledger debit (`jackpot_stake:` plus the idempotency key) and the same key does not debit twice. A purchase after the closing time is rejected. Settlement reads finished scores, or 1X2 results the admin enters. A void, cancelled, postponed, or abandoned match counts as correct for every ticket. If every match is void the stakes are refunded and the grand prize is not paid. Otherwise a full set of correct picks pays the grand prize and a configured tier pays that tier. Each credit uses `jackpot_payout:` plus the ticket id, so settling again does not pay again. Cancel refunds each pending ticket once. Delete works only when the jackpot has no tickets.

Aviator is a real shared round on the ledger, not the old browser demo. One API worker holds Postgres lock `842164221`. A round has a betting window (5 seconds), flight, and a 5 second crash display. The crash point is fixed when the round opens from SHA-256 of the server seed, the public client seed `ushindi`, and the round number, using PesaBetPro's Bustabit formula at 96% RTP (house edge 4%) and a 1000x cap. The server seed hash is public before the round. The seed is revealed after the crash. Bets and cashouts go through the ledger. Cash out uses the server clock and rejects once the multiplier has reached the crash. Two panels and auto cash out are supported. A restart or an aborted betting round refunds open stakes. `GET /api/crash/current` and `POST /api/crash/start` are gone (410). Admin → Aviator sets RTP, limits, timing, and the on/off switch, and those changes are audited. Stake defaults are TSH 100 to 2,000,000, and a single win is capped at TSH 10,000,000.

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
- Admin writes are appended to `audit_log`. The server checks that the caller is an admin on every request. Players cannot open those routes. `POST /api/admin/users/:id/reset-password` uses the same origin and CSRF checks, and it is rate limited (`PASSWORD_RESET_RATE_LIMIT_MAX`, 10 per 15 minutes).

Real launch still needs a Gaming Board of Tanzania licence, a payment provider that credits the ledger, a paid API-Football plan if you do not enter fixtures by hand, KYC, and legal review. Deposits and withdrawals are not wired to the ledger in this step.
