# REA Findings — Betika home (functional patterns only)

Evidence: `ev_a9176a85cf84511a65b07f7d06f1c7d938dcc5b1571e4cb733f42359bb7b43fa`
Capture file: `/home/box/.cursor/projects/workspace/agent-tools/b9e3373b-3eab-4fa4-aac5-05d544fc50ce.txt`
Screenshot: `/workspace/betika-rea-home.png`

> No Betika code, assets, logos, banner images, marketing text, or odds data were copied. Ushindi Bet keeps its own name, colours, Swahili/English text, TZS mock data, and original teams/markets.

## Observed (home only)
- Top nav links inferred from captured page/links: Home, Live, Jackpots, Aviator/Crash-style, Casino, Promotions, Virtuals, Livescore; search + login/register entry points.
- Sports rail with many sports (~20+ in capture) and counts; selecting a sport narrows the match list.
- Home controls: Highlights / Upcoming tabs, Countries, Filters, Today, market selector with 1X2 default, match rows grouped by league, live minute/score, '+N Markets' link to match page, Load More pagination.
- API calls seen in capture traffic (host/paths only, no data reused): `api.betika.com/v1/uo/matches?...sport_id=14...`, `/v1/uo/sports`, `/v1/uo/sport?...id=14`, `/v1/uo/totalMatches`, `/v1/sports` and `live.betika.com` for live data.

## How Ushindi maps each pattern
| Observed pattern | Ushindi implementation |
|---|---|
| Top nav + live/promotion counts | `App.vue`: Home, Live (live-count badge from Pinia matches), Jackpots, Crash, Casino, Promotions (promo-count badge), Virtuals, Livescore, Print Fixtures, Search, Login/Register |
| ~18-sport rail with counts | `data/mock.ts` `sportsDetailed` (18 sports, original TZ names in Swahili) rendered in `App.vue`; click sets `useMatches.selectedSport` and routes home; `Home.vue` filters by it |
| Highlights/Upcoming, Countries, Filters, Today, 1X2 selector | `Home.vue`: tabs, Countries strip, collapsible Filters (live-only + sport), Today toggle, market selector default `1X2` (OU/BTTS switch displayed derived mock columns with note) |
| Grouped rows, Dar es Salaam time, LIVE minute+score, +N Markets, Load More | `Home.vue` groups by `league • country`, `fmtTime()` uses `Africa/Dar_es_Salaam`, live badge minute/score, `+{marketsCount} Markets` link, Load More appends `moreMatches()` |
| Hero/promo area | Text-only rotating carousel in `Home.vue` (`heroSlides`): Deposit Bonus, Cashout, Live Betting, Crash — original Ushindi wording, no images |
| Livescore / Print Fixtures | New routes `/livescore` (`Livescore.vue`) and `/fixtures/print` (`FixturesPrint.vue`, printable table + `window.print()`) |
| API shapes `/v1/uo/*` | Fastify aliases in `apps/api/src/index.ts`: `/v1/uo/matches` (page/limit/sport_id/live, margin-applied mock), `/v1/uo/sports`, `/v1/uo/totalMatches`, `/v1/uo/sport?id=` — `/api/*` unchanged |
| SPA deep links | `apps/web/nginx.conf`: `try_files $uri $uri/ /index.html;` copied in web Dockerfile |
| Footer SEO/legal | Original Ushindi paragraph in `App.vue` footer + Responsible Gambling / Terms / Privacy links (not Betika text) |

## Limitations
- Only the public home page was captured; no login, betslip, cashier, or authenticated routes were exercised.
- Sub-page routes and API parameters beyond home traffic are inferred from visible links/query names, not verified end-to-end.
- All Ushindi odds/fixtures remain sandbox mock data from its own mock feed adapter with operator margin; no real odds were taken.
