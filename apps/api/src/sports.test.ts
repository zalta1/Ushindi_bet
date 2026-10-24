import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseApiFootballBookmakers } from './sports/feed.js'
import { runSportsCycle } from './sports/worker.js'

process.env.NODE_ENV = 'test'
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'false'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test'
process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
delete process.env.SUPER_ADMIN_PHONE
delete process.env.SUPER_ADMIN_PASSWORD
delete process.env.ADMIN_PHONE
delete process.env.ADMIN_PASSWORD
delete process.env.API_SPORTS_KEY
delete process.env.REDIS_URL

const dbName = new URL(process.env.DATABASE_URL).pathname
if (!dbName.includes('test')) throw new Error(`Refusing to run sports tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 800
let keyN = 0

function nextPhone() {
  n += 1
  return phone(n)
}

function key() {
  keyN += 1
  return `sports-key-${String(keyN).padStart(6, '0')}`
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  Object.assign(operatorConfig, {
    marginBps: 600,
    minStake: 500,
    maxStake: 500000,
    minWithdraw: 1000,
    maxWithdraw: 5000000,
    minDeposit: 30000,
    maxDeposit: 5000000,
    rtpBps: 9700,
    withdrawalsEnabled: true,
    cashoutEnabled: false,
    cashoutMarginBps: 1200,
    payoutPercentBps: 8800,
    feedSyncEnabled: false,
    lifecycleEnabled: false,
    hotMatchesAuto: false,
    feedSyncIntervalSec: 300,
    liveOddsIntervalSec: 60,
    lifecycleIntervalSec: 30,
    welcomeBonusEnabled: false,
    welcomeBonusTzs: 0,
    securityDepositTzs: 0,
    securityUnlockTzs: 0,
    agentWhatsapp: '',
    maintenanceMode: false,
  })
  await pool.query(`DELETE FROM settings`)
  await pool.query(`DELETE FROM match_api_keys`)
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`DELETE FROM odds WHERE market_id IN (SELECT id FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome%'))`)
  await pool.query(`DELETE FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome%')`)
  await pool.query(`DELETE FROM matches WHERE home LIKE 'Testhome%'`)
})

after(async () => {
  await pool.query(`DELETE FROM odds WHERE market_id IN (SELECT id FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome%'))`).catch(() => undefined)
  await pool.query(`DELETE FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome%')`).catch(() => undefined)
  await pool.query(`DELETE FROM matches WHERE home LIKE 'Testhome%'`).catch(() => undefined)
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201)
  return { client, number, id: created.json.user.id as string }
}

async function adminAndPlayer(balance = 50_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit',
    amountTzs: balance,
    reason: 'sports test stake',
  })
  assert.equal(credited.status, 200)
  return { admin, player }
}

async function createMatch(admin: Client, home: string, homePrice = 2) {
  const res = await admin.send('POST', '/api/admin/matches', {
    home,
    away: 'Testaway',
    league: 'Test League',
    country: 'Tanzania',
    kickoff: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'upcoming',
    odds: { home: homePrice, draw: 3.2, away: 3.4, over25: 1.9, under25: 1.85 },
  })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  const homeOdd = res.json.odds.find((row: { selection: string }) => row.selection === '1')
  const over = res.json.odds.find((row: { selection: string }) => row.selection === 'Over 2.5')
  return { id: res.json.id as number, oddsId: homeOdd.id as number, price: homeOdd.price as number, overId: over.id as number, overPrice: over.price as number }
}

async function balanceOf(client: Client) {
  const me = await client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  return me.json.user.balanceTzs as number
}

function place(client: Client, odds: { oddsId: number; price: number }[], stake: number, idempotencyKey = key()) {
  return client.send('POST', '/api/bets', { idempotencyKey, stakeTzs: stake, legs: odds })
}

test('API-Football bookmakers map to the markets we settle', () => {
  const parsed = parseApiFootballBookmakers([
    {
      id: 8,
      bets: [
        { id: 1, values: [{ value: 'Home', odd: '2.10' }, { value: 'Draw', odd: '3.20' }, { value: 'Away', odd: '3.40' }] },
        { id: 8, values: [{ value: 'Yes', odd: '1.80' }, { value: 'No', odd: '1.95' }] },
        { id: 5, values: [{ value: 'Over 2.5', odd: '1.90' }, { value: 'Under 2.5', odd: '1.85' }, { value: 'Over 3.5', odd: '1.40', suspended: true }] },
        { id: 12, values: [{ value: 'Home/Draw', odd: '1.30' }] },
      ],
    },
  ])
  const bySel = Object.fromEntries(parsed.map((row) => [`${row.market}:${row.selection}`, row.price]))
  assert.equal(bySel['1X2:1'], 2.1)
  assert.equal(bySel['1X2:X'], 3.2)
  assert.equal(bySel['BTTS:Yes'], 1.8)
  assert.equal(bySel['Over/Under:Over 2.5'], 1.9)
  assert.equal(bySel['Over/Under:Over 3.5'], undefined)
  assert.equal(bySel['Double Chance:1X'], 1.3)
})

test('public matches come from Postgres and include odds ids', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/matches' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(Array.isArray(body))
  const simba = body.find((match: { home: string }) => match.home === 'Simba SC')
  assert.ok(simba)
  assert.equal(simba.live, true)
  assert.ok(simba.odds[0].oddsId > 0)
  assert.ok(simba.odds[0].price > 1)
  const limits = await app.inject({ method: 'GET', url: '/api/bets/limits' })
  assert.equal(limits.statusCode, 200)
  assert.equal(limits.json().minStake, 500)
  assert.equal(limits.json().payoutPercentBps, 8800)
  const quote = await app.inject({ method: 'GET', url: '/api/bets/quote?stake=1000&price=2&price=1.5' })
  assert.equal(quote.statusCode, 200)
  assert.equal(quote.json().potentialPayoutTzs, 2640)
  assert.equal(quote.json().payoutPercentBps, 8800)
})

test('sync without an API-Football key does not call the feed', async () => {
  const { admin } = await adminAndPlayer(1000)
  const sync = await admin.client.send('POST', '/api/admin/matches/sync', {})
  assert.equal(sync.status, 400)
  assert.equal(sync.json.error, 'no_api_key')
  const added = await admin.client.send('POST', '/api/admin/match-api', { label: 'Akaunti', apiKey: 'test-key-not-real-1234' })
  assert.equal(added.status, 200)
  assert.equal(JSON.stringify(added.json).includes('test-key-not-real-1234'), false)
  const listed = await admin.client.send('GET', '/api/admin/match-api')
  assert.equal(JSON.stringify(listed.json).includes('test-key-not-real-1234'), false)
  assert.equal(listed.json.provider, 'api-football')
})

test('placement rechecks odds, debits the ledger, and replays the same key', async () => {
  const { player, admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Place')
  const before = await balanceOf(player.client)
  const placed = await place(player.client, [{ oddsId: match.oddsId, price: match.price }], 1000, 'sports-place-0001')
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  assert.equal(placed.json.potentialPayoutTzs, 1760)
  assert.equal(placed.json.payoutPercentBps, 8800)
  assert.equal(placed.json.balanceTzs, before - 1000)
  const replay = await place(player.client, [{ oddsId: match.oddsId, price: match.price }], 1000, 'sports-place-0001')
  assert.equal(replay.status, 200)
  assert.equal(replay.json.idempotent, true)
  assert.equal(replay.json.betId, placed.json.betId)
  assert.equal(await balanceOf(player.client), before - 1000)

  const changed = await place(player.client, [{ oddsId: match.oddsId, price: 9.5 }], 1000)
  assert.equal(changed.status, 409)
  assert.equal(changed.json.error, 'odds_changed')
  const low = await place(player.client, [{ oddsId: match.oddsId, price: match.price }], 100)
  assert.equal(low.status, 400)
  assert.equal(low.json.fields.stakeTzs, 'min')
  const broke = await place(player.client, [{ oddsId: match.oddsId, price: match.price }], 60_000)
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')
  assert.equal(await balanceOf(player.client), before - 1000)

  const mine = await player.client.send('GET', '/api/bets?status=open')
  assert.equal(mine.status, 200)
  assert.equal(mine.json.data.length, 1)
  assert.equal(mine.json.data[0].legs[0].selection, '1')
})

test('a winning settle credits once and a second settle does not', async () => {
  const { player, admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Win', 2)
  const placed = await place(player.client, [{ oddsId: match.oddsId, price: 2 }], 1000)
  assert.equal(placed.status, 200)
  const afterStake = await balanceOf(player.client)
  const denied = await player.client.send('POST', `/api/admin/matches/${match.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(denied.status, 403)

  const settled = await admin.client.send('POST', `/api/admin/matches/${match.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(settled.status, 200, JSON.stringify(settled.json))
  assert.equal(settled.json.alreadySettled, false)
  assert.equal(settled.json.creditedTzs, 1760)
  assert.equal(await balanceOf(player.client), afterStake + 1760)

  const again = await admin.client.send('POST', `/api/admin/matches/${match.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(again.status, 200)
  assert.equal(again.json.alreadySettled, true)
  assert.equal(again.json.creditedTzs, 0)
  assert.equal(await balanceOf(player.client), afterStake + 1760)
  const wins = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win'`,
    [player.id],
  )
  assert.equal(wins.rows[0].n, 1)
  const won = await player.client.send('GET', '/api/bets?status=won')
  assert.equal(won.json.data[0].status, 'won')

  const parallelMatch = await createMatch(admin.client, 'Testhome Parallel', 3)
  const parallelBet = await place(player.client, [{ oddsId: parallelMatch.oddsId, price: 3 }], 1000)
  assert.equal(parallelBet.status, 200)
  const beforeParallel = await balanceOf(player.client)
  const [first, second] = await Promise.all([
    admin.client.send('POST', `/api/admin/matches/${parallelMatch.id}/settle`, { homeScore: 1, awayScore: 0 }),
    admin.client.send('POST', `/api/admin/matches/${parallelMatch.id}/settle`, { homeScore: 1, awayScore: 0 }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  const credited = [first, second].filter((row) => row.json.alreadySettled === false)
  assert.equal(credited.length, 1)
  assert.equal(await balanceOf(player.client), beforeParallel + 2640)
  const winRows = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win'`,
    [player.id],
  )
  assert.equal(winRows.rows[0].n, 2)
})

test('a losing result pays nothing and a void refunds the stake once', async () => {
  const { player, admin } = await adminAndPlayer()
  const lostMatch = await createMatch(admin.client, 'Testhome Lose', 2)
  const lostBet = await place(player.client, [{ oddsId: lostMatch.oddsId, price: 2 }], 1000)
  assert.equal(lostBet.status, 200)
  const afterLostStake = await balanceOf(player.client)
  const lost = await admin.client.send('POST', `/api/admin/matches/${lostMatch.id}/settle`, { homeScore: 0, awayScore: 2 })
  assert.equal(lost.status, 200)
  assert.equal(lost.json.creditedTzs, 0)
  assert.equal(await balanceOf(player.client), afterLostStake)
  const lostList = await player.client.send('GET', '/api/bets?status=lost')
  assert.equal(lostList.json.data.length, 1)

  const voidMatch = await createMatch(admin.client, 'Testhome Void', 2)
  const voidBet = await place(player.client, [{ oddsId: voidMatch.oddsId, price: 2 }], 1500)
  assert.equal(voidBet.status, 200)
  const afterVoidStake = await balanceOf(player.client)
  const voided = await admin.client.send('POST', `/api/admin/matches/${voidMatch.id}/void`, { reason: 'mechi imeahirishwa' })
  assert.equal(voided.status, 200, JSON.stringify(voided.json))
  assert.equal(voided.json.alreadySettled, false)
  assert.equal(voided.json.creditedTzs, 1500)
  assert.equal(await balanceOf(player.client), afterVoidStake + 1500)
  const voidAgain = await admin.client.send('POST', `/api/admin/matches/${voidMatch.id}/void`, { reason: 'mechi imeahirishwa' })
  assert.equal(voidAgain.json.alreadySettled, true)
  assert.equal(await balanceOf(player.client), afterVoidStake + 1500)
  const refunds = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'refund'`,
    [player.id],
  )
  assert.equal(refunds.rows[0].n, 1)

  const overMatch = await createMatch(admin.client, 'Testhome Over', 2)
  const overBet = await place(player.client, [{ oddsId: overMatch.overId, price: overMatch.overPrice }], 1000)
  assert.equal(overBet.status, 200)
  const beforeOver = await balanceOf(player.client)
  const over = await admin.client.send('POST', `/api/admin/matches/${overMatch.id}/settle`, { homeScore: 2, awayScore: 1 })
  assert.equal(over.status, 200)
  assert.equal(over.json.creditedTzs, 1672)
  assert.equal(await balanceOf(player.client), beforeOver + 1672)
})

test('a multi loses on one lost leg and stays open until every leg is settled', async () => {
  const { player, admin } = await adminAndPlayer()
  const home = await createMatch(admin.client, 'Testhome Multi A', 2)
  const away = await createMatch(admin.client, 'Testhome Multi B', 1.5)
  const openBet = await place(player.client, [
    { oddsId: home.oddsId, price: 2 },
    { oddsId: away.oddsId, price: 1.5 },
  ], 1000)
  assert.equal(openBet.status, 200)
  assert.equal(openBet.json.potentialPayoutTzs, 2640)
  const afterStake = await balanceOf(player.client)
  const first = await admin.client.send('POST', `/api/admin/matches/${home.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(first.json.creditedTzs, 0)
  const stillOpen = await player.client.send('GET', '/api/bets?status=open')
  assert.equal(stillOpen.json.data.length, 1)
  assert.equal(await balanceOf(player.client), afterStake)
  const second = await admin.client.send('POST', `/api/admin/matches/${away.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(second.json.creditedTzs, 2640)
  assert.equal(await balanceOf(player.client), afterStake + 2640)

  const loseHome = await createMatch(admin.client, 'Testhome Multi C', 2)
  const loseAway = await createMatch(admin.client, 'Testhome Multi D', 2)
  const loseBet = await place(player.client, [
    { oddsId: loseHome.oddsId, price: 2 },
    { oddsId: loseAway.oddsId, price: 2 },
  ], 1000)
  assert.equal(loseBet.status, 200)
  const afterLoseStake = await balanceOf(player.client)
  await admin.client.send('POST', `/api/admin/matches/${loseHome.id}/settle`, { homeScore: 0, awayScore: 1 })
  const lost = await player.client.send('GET', '/api/bets?status=lost')
  assert.ok(lost.json.data.some((bet: { id: string }) => bet.id === loseBet.json.betId))
  const later = await admin.client.send('POST', `/api/admin/matches/${loseAway.id}/settle`, { homeScore: 3, awayScore: 0 })
  assert.equal(later.json.creditedTzs, 0)
  assert.equal(await balanceOf(player.client), afterLoseStake)
})

async function addSelection(admin: Client, matchId: number, market: string, selection: string, price: number, line?: number) {
  const res = await admin.send('POST', `/api/admin/matches/${matchId}/odds`, { market, selection, price, line })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.id as number
}

test('anonymous callers cannot use the old sandbox settle, payment, crash, or uo feeds', async () => {
  for (const url of ['/api/settle/1', '/api/payments/deposit', '/api/crash/start']) {
    const res = await app.inject({ method: 'POST', url, payload: { amount: 1000, provider: 'M-Pesa' } })
    assert.equal(res.statusCode, 401, url)
  }
  for (const url of ['/v1/uo/matches', '/v1/uo/sports', '/v1/uo/totalMatches', '/v1/uo/sport']) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 401, url)
  }
  const player = await register()
  const feed = await player.client.send('GET', '/v1/uo/matches')
  assert.equal(feed.status, 200)
  assert.equal(feed.json.meta.sandbox, true)
  const crash = await player.client.send('POST', '/api/crash/start', {})
  assert.equal(crash.status, 410)
  assert.equal(crash.json.error, 'gone')
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const allowed = await admin.client.send('POST', '/api/crash/start', { clientSeed: 'test' })
  assert.equal(allowed.status, 410)
  assert.equal(allowed.json.error, 'gone')
})

test('correct score, handicaps, draw no bet, and the other full-time markets settle', async () => {
  const { player, admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Markets', 2)
  const scoreId = await addSelection(admin.client, match.id, 'Correct Score', '2-1', 8)
  const homeH = await addSelection(admin.client, match.id, '3-Way Handicap -1', 'Home -1', 3.4, -1)
  const drawH = await addSelection(admin.client, match.id, '3-Way Handicap -1', 'Draw -1', 3.3, -1)
  const asian = await addSelection(admin.client, match.id, '2-Way Handicap -1', 'Home -1', 1.9, -1)
  const dnb = await addSelection(admin.client, match.id, 'Draw No Bet', '1', 1.5)
  const odd = await addSelection(admin.client, match.id, 'Odd/Even', 'Odd', 1.9)
  const exact = await addSelection(admin.client, match.id, 'Exact Goals', '3+', 2.5)

  const wonScore = await place(player.client, [{ oddsId: scoreId, price: 8 }], 1000)
  assert.equal(wonScore.status, 200)
  const settled = await admin.client.send('POST', `/api/admin/matches/${match.id}/settle`, { homeScore: 2, awayScore: 1 })
  assert.equal(settled.status, 200)
  assert.equal(settled.json.creditedTzs, 7040)

  const push = await createMatch(admin.client, 'Testhome Asian', 2)
  await addSelection(admin.client, push.id, '2-Way Handicap -1', 'Home -1', 1.9, -1)
  const pushOdd = await pool.query<{ id: number; price: string }>(
    `SELECT o.id, o.price::text FROM odds o JOIN markets mk ON mk.id = o.market_id WHERE mk.match_id = $1 AND mk.code = '2-Way Handicap -1' AND o.selection = 'Home -1'`,
    [push.id],
  )
  const pushBet = await place(player.client, [{ oddsId: pushOdd.rows[0].id, price: Number(pushOdd.rows[0].price) }], 1000)
  assert.equal(pushBet.status, 200)
  const before = await balanceOf(player.client)
  const pushed = await admin.client.send('POST', `/api/admin/matches/${push.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(pushed.json.creditedTzs, 1000)
  assert.equal(await balanceOf(player.client), before + 1000)

  const three = await createMatch(admin.client, 'Testhome Three', 2)
  const drawOdd = await addSelection(admin.client, three.id, '3-Way Handicap -1', 'Draw -1', 3.3, -1)
  await place(player.client, [{ oddsId: drawOdd, price: 3.3 }], 1000)
  const threeSettle = await admin.client.send('POST', `/api/admin/matches/${three.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(threeSettle.json.creditedTzs, 2904)

  const dnbMatch = await createMatch(admin.client, 'Testhome Dnb', 2)
  const dnbOdd = await addSelection(admin.client, dnbMatch.id, 'Draw No Bet', '1', 1.5)
  await place(player.client, [{ oddsId: dnbOdd, price: 1.5 }], 1000)
  const dnbSettle = await admin.client.send('POST', `/api/admin/matches/${dnbMatch.id}/settle`, { homeScore: 1, awayScore: 1 })
  assert.equal(dnbSettle.json.creditedTzs, 1000)

  const goals = await createMatch(admin.client, 'Testhome Goals', 2)
  const oddId = await addSelection(admin.client, goals.id, 'Odd/Even', 'Odd', 1.9)
  const exactId = await addSelection(admin.client, goals.id, 'Exact Goals', '3+', 2.5)
  await place(player.client, [{ oddsId: oddId, price: 1.9 }], 1000)
  const oddSettle = await admin.client.send('POST', `/api/admin/matches/${goals.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(oddSettle.json.creditedTzs, 1672)
  const many = await createMatch(admin.client, 'Testhome Exact', 2)
  const manyId = await addSelection(admin.client, many.id, 'Exact Goals', '3+', 2.5)
  await place(player.client, [{ oddsId: manyId, price: 2.5 }], 1000)
  const manySettle = await admin.client.send('POST', `/api/admin/matches/${many.id}/settle`, { homeScore: 2, awayScore: 2 })
  assert.equal(manySettle.json.creditedTzs, 2200)
  assert.ok(homeH && asian && odd && exact && exactId)
})

test('API-Football correct score and handicap ids map onto settleable markets', () => {
  const parsed = parseApiFootballBookmakers([
    {
      id: 8,
      bets: [
        { id: 10, values: [{ value: '2-1', odd: '9.50' }, { value: '9-0', odd: '50' }] },
        { id: 4, values: [{ value: 'Home -1', odd: '3.40' }, { value: 'Draw -1', odd: '3.30' }] },
        { id: 33, values: [{ value: 'Home -0.5', odd: '1.80', handicap: '-0.5' }, { value: 'Away -0.5', odd: '2.00', handicap: '-0.5' }] },
        { id: 29, values: [{ value: 'Home', odd: '1.40' }, { value: 'Away', odd: '2.80' }] },
      ],
    },
  ])
  const bySel = Object.fromEntries(parsed.map((row) => [`${row.market}:${row.selection}`, row.price]))
  assert.equal(bySel['Correct Score:2-1'], 9.5)
  assert.equal(bySel['Correct Score:9-0'], undefined)
  assert.equal(bySel['3-Way Handicap -1:Home -1'], 3.4)
  assert.equal(bySel['2-Way Handicap -0.5:Away +0.5'], 2)
  assert.equal(bySel['Draw No Bet:1'], 1.4)
})

test('hot matches are an admin flag and show on the public list', async () => {
  const listed = await app.inject({ method: 'GET', url: '/api/matches' })
  const simba = listed.json().find((match: { home: string }) => match.home === 'Simba SC')
  assert.equal(simba.hot, true)
  const { admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Hot', 2)
  const on = await admin.client.send('POST', `/api/admin/matches/${match.id}/hot`, { hot: true })
  assert.equal(on.status, 200)
  const again = await app.inject({ method: 'GET', url: '/api/matches' })
  const row = again.json().find((item: { id: number }) => item.id === match.id)
  assert.equal(row.hot, true)
  const audit = await pool.query(`SELECT action FROM audit_log WHERE action = 'matches.hot'`)
  assert.equal(audit.rows.length, 1)
})

test('match details fall back without calling API-Football when there is no key', async () => {
  const listed = await app.inject({ method: 'GET', url: '/api/matches' })
  const simba = listed.json().find((match: { home: string }) => match.home === 'Simba SC')
  const res = await app.inject({ method: 'GET', url: `/api/matches/${simba.id}` })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().details.source, 'sample')
  assert.ok(res.json().details.events.length >= 1)
  assert.ok(res.json().details.lineups.home.length >= 1)
  assert.ok(res.json().markets['Correct Score'])
  const { admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Details', 2)
  const bare = await app.inject({ method: 'GET', url: `/api/matches/${match.id}` })
  assert.equal(bare.json().details.source, 'unavailable')
  assert.deepEqual(bare.json().details.events, [])
  assert.ok(bare.json().markets['1X2'])
})

test('2UP pays a single early, does not pay twice, and a VAR reversal debits the ledger', async () => {
  const { player, admin } = await adminAndPlayer()
  const match = await createMatch(admin.client, 'Testhome Two', 2)
  const saved = await admin.client.send('POST', `/api/admin/matches/${match.id}/two-up`, {
    enabled: true,
    homeOdds: 2,
    drawOdds: 3.2,
    awayOdds: 3.4,
    team: 'both',
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  const home = saved.json.odds.find((row: { selection: string }) => row.selection === '1')
  const placed = await place(player.client, [{ oddsId: home.id, price: 2 }], 1000)
  assert.equal(placed.status, 200)
  const afterStake = await balanceOf(player.client)
  const early = await admin.client.send('POST', `/api/admin/matches/${match.id}/score`, { homeScore: 2, awayScore: 0, minute: 30 })
  assert.equal(early.status, 200, JSON.stringify(early.json))
  assert.equal(early.json.paid, 1)
  assert.equal(await balanceOf(player.client), afterStake + 1760)
  const again = await admin.client.send('POST', `/api/admin/matches/${match.id}/score`, { homeScore: 2, awayScore: 0, minute: 40 })
  assert.equal(again.json.paid, 0)
  assert.equal(await balanceOf(player.client), afterStake + 1760)
  const reversed = await admin.client.send('POST', `/api/admin/matches/${match.id}/score`, { homeScore: 1, awayScore: 0, minute: 44 })
  assert.equal(reversed.json.reversed, 1)
  assert.equal(await balanceOf(player.client), afterStake)
  const draw = saved.json.odds.find((row: { selection: string }) => row.selection === 'X')
  await place(player.client, [{ oddsId: draw.id, price: 3.2 }], 1000)
  const beforeDraw = await balanceOf(player.client)
  const notEarly = await admin.client.send('POST', `/api/admin/matches/${match.id}/score`, { homeScore: 2, awayScore: 0, minute: 50 })
  assert.equal(notEarly.json.paid, 1)
  const mine = await player.client.send('GET', '/api/bets?status=open')
  assert.ok(mine.json.data.some((bet: { legs: { selection: string }[] }) => bet.legs.some((leg) => leg.selection === 'X')))
  assert.equal(await balanceOf(player.client), beforeDraw + 1760)
})

test('a stored payout percent is unchanged when settings change, and a void leg still pays the reduced win', async () => {
  const { player, admin } = await adminAndPlayer()
  const first = await createMatch(admin.client, 'Testhome Percent', 2)
  const placed = await place(player.client, [{ oddsId: first.oddsId, price: 2 }], 1000)
  assert.equal(placed.json.potentialPayoutTzs, 1760)
  assert.equal(placed.json.payoutPercentBps, 8800)
  const stored = await pool.query<{ payout_percent_bps: number; potential_payout_tzs: string }>(
    `SELECT payout_percent_bps, potential_payout_tzs::text FROM bets WHERE id = $1`,
    [placed.json.betId],
  )
  assert.equal(stored.rows[0].payout_percent_bps, 8800)
  const rejected = await admin.client.send('PATCH', '/api/admin/config', { payoutPercentBps: 0 })
  assert.equal(rejected.status, 400)
  const changed = await admin.client.send('PATCH', '/api/admin/config', { payoutPercentBps: 7000 })
  assert.equal(changed.status, 200, JSON.stringify(changed.json))
  assert.equal(changed.json.payoutPercentBps, 7000)
  const kept = await pool.query<{ payout_percent_bps: number }>(`SELECT payout_percent_bps FROM bets WHERE id = $1`, [placed.json.betId])
  assert.equal(kept.rows[0].payout_percent_bps, 8800)
  const afterStake = await balanceOf(player.client)
  const settled = await admin.client.send('POST', `/api/admin/matches/${first.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(settled.json.creditedTzs, 1760)
  assert.equal(await balanceOf(player.client), afterStake + 1760)

  const later = await createMatch(admin.client, 'Testhome Later', 2)
  const next = await place(player.client, [{ oddsId: later.oddsId, price: 2 }], 1000)
  assert.equal(next.json.potentialPayoutTzs, 1400)
  assert.equal(next.json.payoutPercentBps, 7000)

  operatorConfig.payoutPercentBps = 8800
  const home = await createMatch(admin.client, 'Testhome Voidleg A', 2)
  const away = await createMatch(admin.client, 'Testhome Voidleg B', 1.5)
  const multi = await place(player.client, [
    { oddsId: home.oddsId, price: 2 },
    { oddsId: away.oddsId, price: 1.5 },
  ], 1000)
  assert.equal(multi.json.potentialPayoutTzs, 2640)
  await admin.client.send('POST', `/api/admin/matches/${home.id}/void`, { reason: 'mechi imeahirishwa' })
  const before = await balanceOf(player.client)
  const won = await admin.client.send('POST', `/api/admin/matches/${away.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(won.json.creditedTzs, 1320)
  assert.equal(await balanceOf(player.client), before + 1320)
})

test('cashout never exceeds the win stored on the ticket', async () => {
  const { player, admin } = await adminAndPlayer()
  operatorConfig.cashoutEnabled = true
  operatorConfig.cashoutMarginBps = 0
  const match = await createMatch(admin.client, 'Testhome Cap', 2)
  const placed = await place(player.client, [{ oddsId: match.oddsId, price: 2 }], 1000)
  assert.equal(placed.json.potentialPayoutTzs, 1760)
  await pool.query(`UPDATE odds SET price = 1.10 WHERE id = $1`, [match.oddsId])
  const quote = await player.client.send('GET', `/api/bets/${placed.json.betId}/cashout`)
  assert.equal(quote.status, 200, JSON.stringify(quote.json))
  assert.equal(quote.json.cashoutTzs, 1760)
  const before = await balanceOf(player.client)
  const paid = await player.client.send('POST', `/api/bets/${placed.json.betId}/cashout`, { expectedTzs: 1760 })
  assert.equal(paid.status, 200, JSON.stringify(paid.json))
  assert.equal(paid.json.creditedTzs, 1760)
  assert.equal(await balanceOf(player.client), before + 1760)
})

test('cashout recomputes on the server, credits once, and stops after settlement or suspension', async () => {
  const { player, admin } = await adminAndPlayer()
  operatorConfig.cashoutEnabled = true
  operatorConfig.cashoutMarginBps = 1200
  const match = await createMatch(admin.client, 'Testhome Cash', 2)
  const placed = await place(player.client, [{ oddsId: match.oddsId, price: match.price }], 1000)
  assert.equal(placed.status, 200)
  const quote = await player.client.send('GET', `/api/bets/${placed.json.betId}/cashout`)
  assert.equal(quote.json.cashoutTzs, 880)
  const off = operatorConfig.cashoutEnabled
  operatorConfig.cashoutEnabled = false
  const blocked = await player.client.send('POST', `/api/bets/${placed.json.betId}/cashout`, { expectedTzs: 880 })
  assert.equal(blocked.status, 403)
  operatorConfig.cashoutEnabled = off
  const stale = await player.client.send('POST', `/api/bets/${placed.json.betId}/cashout`, { expectedTzs: 100 })
  assert.equal(stale.status, 409)
  const before = await balanceOf(player.client)
  const paid = await player.client.send('POST', `/api/bets/${placed.json.betId}/cashout`, { expectedTzs: 880 })
  assert.equal(paid.status, 200, JSON.stringify(paid.json))
  assert.equal(paid.json.creditedTzs, 880)
  assert.equal(await balanceOf(player.client), before + 880)
  const replay = await player.client.send('POST', `/api/bets/${placed.json.betId}/cashout`, { expectedTzs: 880 })
  assert.equal(replay.status, 200)
  assert.equal(replay.json.idempotent, true)
  assert.equal(await balanceOf(player.client), before + 880)

  const suspended = await createMatch(admin.client, 'Testhome Suspend', 2)
  const open = await place(player.client, [{ oddsId: suspended.oddsId, price: suspended.price }], 1000)
  await pool.query(`UPDATE odds SET suspended = true WHERE id = $1`, [suspended.oddsId])
  const denied = await player.client.send('POST', `/api/bets/${open.json.betId}/cashout`, { expectedTzs: 880 })
  assert.equal(denied.status, 409)

  const finished = await createMatch(admin.client, 'Testhome After', 2)
  const last = await place(player.client, [{ oddsId: finished.oddsId, price: finished.price }], 1000)
  await admin.client.send('POST', `/api/admin/matches/${finished.id}/settle`, { homeScore: 1, awayScore: 0 })
  const closed = await player.client.send('POST', `/api/bets/${last.json.betId}/cashout`, { expectedTzs: 880 })
  assert.equal(closed.status, 409)
})

test('the lifecycle worker starts a match once and settles full time once', async () => {
  const { admin } = await adminAndPlayer()
  const kept = await pool.query<{ id: number; kickoff_at: Date; minute: number }>(
    `SELECT id, kickoff_at, minute FROM matches WHERE status IN ('live', 'upcoming') AND home NOT LIKE 'Testhome%'`,
  )
  await pool.query(
    `UPDATE matches SET kickoff_at = now() + interval '2 days' WHERE id = ANY($1::int[])`,
    [kept.rows.map((row) => row.id)],
  )
  const match = await createMatch(admin.client, 'Testhome Clock', 2)
  await pool.query(`UPDATE matches SET kickoff_at = now() - interval '10 minutes', status = 'upcoming', minute = 0 WHERE id = $1`, [match.id])
  operatorConfig.lifecycleEnabled = true
  operatorConfig.feedSyncEnabled = false
  const first = await runSportsCycle(cfg, { force: true })
  assert.equal(first.skipped, false)
  const live = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [match.id])
  assert.equal(live.rows[0].status, 'live')
  await pool.query(`UPDATE matches SET kickoff_at = now() - interval '100 minutes', home_score = 0, away_score = 0 WHERE id = $1`, [match.id])
  const second = await runSportsCycle(cfg, { force: true })
  assert.equal(second.skipped, false)
  const done = await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [match.id])
  assert.equal(done.rows[0].status, 'finished')
  const third = await runSportsCycle(cfg, { force: true })
  assert.equal((third.detail as { lifecycle?: { settled?: number } }).lifecycle?.settled, 0)
  const runs = await pool.query(`SELECT count(*)::int AS n FROM feed_runs WHERE job = 'sports-cycle' AND ok`)
  assert.ok(runs.rows[0].n >= 3)
  for (const row of kept.rows) {
    await pool.query(`UPDATE matches SET kickoff_at = $2, minute = $3 WHERE id = $1 AND status <> 'finished'`, [row.id, row.kickoff_at, row.minute])
  }
})
