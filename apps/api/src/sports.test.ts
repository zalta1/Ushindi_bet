import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseApiFootballBookmakers } from './sports/feed.js'

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
  assert.equal(placed.json.potentialPayoutTzs, 2000)
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
  assert.equal(settled.json.creditedTzs, 2000)
  assert.equal(await balanceOf(player.client), afterStake + 2000)

  const again = await admin.client.send('POST', `/api/admin/matches/${match.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(again.status, 200)
  assert.equal(again.json.alreadySettled, true)
  assert.equal(again.json.creditedTzs, 0)
  assert.equal(await balanceOf(player.client), afterStake + 2000)
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
  assert.equal(await balanceOf(player.client), beforeParallel + 3000)
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
  assert.equal(over.json.creditedTzs, 1900)
  assert.equal(await balanceOf(player.client), beforeOver + 1900)
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
  assert.equal(openBet.json.potentialPayoutTzs, 3000)
  const afterStake = await balanceOf(player.client)
  const first = await admin.client.send('POST', `/api/admin/matches/${home.id}/settle`, { homeScore: 1, awayScore: 0 })
  assert.equal(first.json.creditedTzs, 0)
  const stillOpen = await player.client.send('GET', '/api/bets?status=open')
  assert.equal(stillOpen.json.data.length, 1)
  assert.equal(await balanceOf(player.client), afterStake)
  const second = await admin.client.send('POST', `/api/admin/matches/${away.id}/settle`, { homeScore: 2, awayScore: 0 })
  assert.equal(second.json.creditedTzs, 3000)
  assert.equal(await balanceOf(player.client), afterStake + 3000)

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
