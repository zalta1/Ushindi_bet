# Ushindi Bet — PLAN (Sandbox Demo, No Real Money)

> Original brand. Inspired only by general sportsbook layout patterns from the spec.
> No Betika branding, assets, code, odds, or copy. Reference site was NOT scraped.

## 1. Product
- **Brand:** Ushindi Bet ("Ushindi" = victory in Swahili). Logo: text wordmark + trophy/shield emoji-free SVG in code. Colours: dark green (#0B3D2E), gold (#F5C518), teal accent.
- **Market:** Tanzania. Currency TZS (no decimals), phones +255, timezone Africa/Dar_es_Salaam for all displayed kick-offs.
- **Languages:** Swahili (default) + English, vue-i18n toggle, persisted.
- **Theme:** Dark default + light, CSS variables, persisted. Mobile-first.
- **Users:** 18+ only (age gate + DOB check on register).

## 2. Sitemap / Routes
`/` Home (sports rail, tabs, filters, match list, betslip) · `/live` Live · `/match/:id` Match (market tabs: Main/Goals/BTTS/Halftime etc.)
`/jackpots` · `/virtuals` · `/casino` · `/crash` · `/promotions` · `/search`
`/login` `/register` `/forgot` (forgot password tells the player, in Swahili and English, to contact support; there is no SMS code) `/set-password`
`/profile` `/deposit` `/withdraw` `/transactions` `/my-bets` `/responsible-gambling` `/terms` `/privacy` `/admin` · `/:pathMatch(.*)*` 404
Layout: desktop 3-col (sports rail | list | betslip), mobile 1-col + bottom tab bar + full-screen betslip overlay.

## 3. Data Model (db/schema.sql — Postgres)
users(id, phone unique +255, password_hash, dob, full_name, kyc_status, rg_limits jsonb, self_excluded_until, created_at)
wallets(id, user_id, balance_tzs, bonus_balance_tzs, currency)
transactions(id, wallet_id, type deposit|withdraw|bet_stake|bet_win|bonus|refund, amount, status, provider, provider_ref, created_at) **APPEND-ONLY ledger: no UPDATE/DELETE (enforced by trigger in schema), balance derived/audited**
bets(id, user_id, stake, combined_odds, potential_payout, status open|won|lost|void, placed_at, settled_at)
bet_legs(id, bet_id, match_id, market, selection, odds_at_placement)
matches(id, sport, league, home, away, kickoff_at, status, home_score, away_score)
markets(id, match_id, name) / odds(id, market_id, selection, price, updated_at)
crash_rounds(id, server_seed_hash [committed pre-round], server_seed [revealed post-round], client_seed, nonce, crash_multiplier, rtp_bps)
kyc_documents(id, user_id, doc_type, status pending|approved|rejected)
promotions(id, title_sw, title_en, wagering_multiplier, active)
audit_log(id, actor, action, payload jsonb, created_at) append-only
official_results(match_id, source, home_score, away_score, verified_at) — settlement source ONLY

## 4. API (Fastify, apps/api — in-memory fallback, runs without DB/Redis)
GET /health · GET /api/matches?live= · GET /api/matches/:id
GET /api/crash/current (seed hash commit) · POST /api/crash/bet {amount,cashoutAt?} · POST /api/crash/cashout · GET /api/crash/verify/:roundId
POST /api/payments/deposit|withdraw (mock provider) · GET /api/admin/config · PATCH /api/admin/config (margin/limits) · GET /api/audit
Optional Redis: odds-tick cache / session — noted, not required locally.

## 5. Fairness / Payments abstractions
- `PaymentProvider` interface (initiateDeposit/Withdraw, verifyCallback) + `MockMobileMoneyProvider` for M-Pesa, Tigo Pesa, Airtel Money, HaloPesa (sandbox only).
- `OddsFeedAdapter` interface + `MockLicensedFeedAdapter`: raw prob -> fair odds -> **operator margin applied** `price = 1 + (fair-1)*(1-margin)`-style in code, admin-configurable marginBps/limits.
- Settlement: only `OfficialResultsProvider` can settle; settlement writes immutable ledger entries + audit_log.
- Crash provably fair: commit `sha256(serverSeed)` before round, HMAC_SHA256(serverSeed, clientSeed:nonce) -> multiplier `max(1, 0.97/(1-r))` cap 100x (RTP 97% published), reveal seed after so anyone can verify. House-edge instant-crash slice included.
- Withdrawal rules shown BEFORE deposit (plain SW+EN): KYC first, 1-24h processing (mock: instant sandbox), min TZS 1,000 / max TZS 5,000,000 per txn, wagering applies to BONUS only — own deposits/winnings never withheld for undisclosed reasons.

## 6. Responsible Gambling
Deposit limits (daily/weekly set in Profile/RG), cooldown 24h, self-exclusion 6mo, reality-check copy, 18+ gate modal, links on RG page.

## 7. Compliance Disclaimer
**Sandbox demo only.** Real launch in Tanzania requires a Gaming Board of Tanzania licence, real payment aggregator + licensed odds-feed contracts, KYC/AML, tax, responsible-gambling certification, and legal review. No real money, odds, SMS, or payments here.

## 8. Milestones
M1 Plan+scaffold (done) · M2 Core betting/betslip/wallet mock · M3 Crash PF + casino/virtuals/jackpots · M4 Auth/RG/admin · M5 Postgres/Redis wiring, tests, licensed integrations (production, not in demo)
