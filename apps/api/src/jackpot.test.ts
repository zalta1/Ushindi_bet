import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'false'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test'
process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
delete process.env.SUPER_ADMIN_PHONE
delete process.env.SUPER_ADMIN_PASSWORD
delete process.env.ADMIN_PHONE
delete process.env.ADMIN_PASSWORD
delete process.env.REDIS_URL

const dbName = new URL(process.env.DATABASE_URL).pathname
if (!dbName.includes('test')) throw new Error(`Refusing to run jackpot tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 1200

function nextPhone() {
  n += 1
  return phone(n)
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`DELETE FROM odds WHERE market_id IN (SELECT id FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome JP%'))`)
  await pool.query(`DELETE FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome JP%')`)
  await pool.query(`DELETE FROM matches WHERE home LIKE 'Testhome JP%'`)
})

after(async () => {
  await pool.query(`DELETE FROM odds WHERE market_id IN (SELECT id FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome JP%'))`).catch(() => undefined)
  await pool.query(`DELETE FROM markets WHERE match_id IN (SELECT id FROM matches WHERE home LIKE 'Testhome JP%')`).catch(() => undefined)
  await pool.query(`DELETE FROM matches WHERE home LIKE 'Testhome JP%'`).catch(() => undefined)
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201)
  return { client, number, id: created.json.user.id as string }
}

async function adminAndPlayer(balance = 100_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit',
    amountTzs: balance,
    reason: 'jackpot test stake',
  })
  assert.equal(credited.status, 200)
  return { admin, player }
}

async function createMatch(admin: Client, home: string) {
  const res = await admin.send('POST', '/api/admin/matches', {
    home,
    away: 'Testaway',
    league: 'Test League',
    country: 'Tanzania',
    kickoff: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    status: 'upcoming',
    odds: { home: 2.1, draw: 3.2, away: 3.4, over25: 1.9, under25: 1.85 },
  })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return res.json.id as number
}

async function matches(admin: Client, count: number) {
  const ids: number[] = []
  for (let i = 0; i < count; i++) ids.push(await createMatch(admin, `Testhome JP ${n}-${i}`))
  return ids
}

function powerBody(matchIds: number[], closingHours = 2) {
  return {
    type: 'power8',
    name: 'Power 8 Jackpot',
    stakeTzs: 1000,
    grandPrizeTzs: 5_000_000,
    tierPrizes: { '7': 50_000, '6': 10_000 },
    closingTime: new Date(Date.now() + closingHours * 3_600_000).toISOString(),
    matchIds,
  }
}

async function balanceOf(client: Client) {
  const me = await client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  return me.json.user.balanceTzs as number
}

test('a jackpot needs the exact fixture count and an admin session', async () => {
  const { admin, player } = await adminAndPlayer()
  const eight = await matches(admin.client, 8)
  const denied = await player.client.send('POST', '/api/admin/jackpots', powerBody(eight))
  assert.equal(denied.status, 403)
  const missing = await app.inject({
    method: 'POST',
    url: '/api/admin/jackpots',
    headers: { cookie: admin.client.header() },
    payload: powerBody(eight),
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')
  const short = await admin.client.send('POST', '/api/admin/jackpots', { ...powerBody(eight), type: 'mega10', matchIds: eight })
  assert.equal(short.status, 400)
  const created = await admin.client.send('POST', '/api/admin/jackpots', powerBody(eight))
  assert.equal(created.status, 200)
  const listed = await app.inject({ method: 'GET', url: '/api/jackpots' })
  assert.equal(listed.statusCode, 200)
  const body = listed.json()
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].totalMatches, 8)
  assert.equal(body.data[0].matches.length, 8)
  assert.equal(body.data[0].matches[0].position, 1)
  const audit = await pool.query<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'admin.jackpot.create'`)
  assert.equal(audit.rows.length, 1)
  const removed = await admin.client.send('POST', `/api/admin/jackpots/${created.json.id}/delete`, {})
  assert.equal(removed.status, 200)
  const gone = await app.inject({ method: 'GET', url: '/api/jackpots' })
  assert.equal(gone.json().data.length, 0)
})

test('buying a ticket debits the ledger once and rejects a late or incomplete slip', async () => {
  const { admin, player } = await adminAndPlayer(5_000)
  const ids = await matches(admin.client, 8)
  const created = await admin.client.send('POST', '/api/admin/jackpots', powerBody(ids))
  assert.equal(created.status, 200)
  const id = created.json.id as string
  const picks = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((pos) => [String(pos), 'home']))
  const key = randomUUID()
  const before = await balanceOf(player.client)
  const bought = await player.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: picks, idempotencyKey: key })
  assert.equal(bought.status, 200, JSON.stringify(bought.json))
  assert.equal(bought.json.duplicate, false)
  assert.equal(await balanceOf(player.client), before - 1000)
  const again = await player.client.send('POST', `/api/jackpots/${id}/tickets`, {
    selections: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((pos) => [String(pos), 'away'])),
    idempotencyKey: key,
  })
  assert.equal(again.status, 200)
  assert.equal(again.json.duplicate, true)
  assert.equal(again.json.ticketId, bought.json.ticketId)
  assert.equal(await balanceOf(player.client), before - 1000)
  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'jackpot'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 1)

  const poor = await register()
  const broke = await poor.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: picks, idempotencyKey: randomUUID() })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')
  const partial = await player.client.send('POST', `/api/jackpots/${id}/tickets`, {
    selections: { '1': 'home' },
    idempotencyKey: randomUUID(),
  })
  assert.equal(partial.status, 400)

  await pool.query(`UPDATE jackpots SET closing_time = now() - interval '1 minute' WHERE id = $1`, [id])
  const late = await player.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: picks, idempotencyKey: randomUUID() })
  assert.equal(late.status, 409)
  assert.equal(late.json.error, 'closed')

  const blocked = await admin.client.send('POST', `/api/admin/jackpots/${id}/delete`, {})
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.error, 'has_tickets')
})

test('settlement pays the grand prize and the tier, and a void match counts as correct', async () => {
  const { admin, player } = await adminAndPlayer(20_000)
  const second = await register()
  await admin.client.send('POST', `/api/admin/users/${second.id}/adjust`, {
    direction: 'credit', amountTzs: 20_000, reason: 'second jackpot ticket',
  })
  const ids = await matches(admin.client, 8)
  const created = await admin.client.send('POST', '/api/admin/jackpots', powerBody(ids))
  const id = created.json.id as string
  const perfect = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((pos) => [String(pos), 'home']))
  const tier = { ...perfect, '7': 'away' }
  const miss = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((pos) => [String(pos), 'away']))
  assert.equal((await player.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: perfect, idempotencyKey: randomUUID() })).status, 200)
  assert.equal((await second.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: tier, idempotencyKey: randomUUID() })).status, 200)
  const loser = await register()
  await admin.client.send('POST', `/api/admin/users/${loser.id}/adjust`, { direction: 'credit', amountTzs: 5_000, reason: 'losing ticket' })
  assert.equal((await loser.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: miss, idempotencyKey: randomUUID() })).status, 200)

  const early = await admin.client.send('POST', `/api/admin/jackpots/${id}/settle`, {})
  assert.equal(early.status, 200, JSON.stringify(early.json))
  assert.equal(early.json.pending, true)
  assert.equal(await balanceOf(player.client), 19_000)

  await pool.query(`UPDATE matches SET status = 'finished', home_score = 2, away_score = 0 WHERE id = ANY($1::int[])`, [ids.slice(0, 7)])
  await pool.query(`UPDATE matches SET status = 'void' WHERE id = $1`, [ids[7]])
  const settled = await admin.client.send('POST', `/api/admin/jackpots/${id}/settle`, {})
  assert.equal(settled.status, 200, JSON.stringify(settled.json))
  assert.equal(settled.json.pending, false)
  assert.equal(settled.json.paid, 2)
  assert.equal(await balanceOf(player.client), 19_000 + 5_000_000)
  assert.equal(await balanceOf(second.client), 19_000 + 50_000)
  assert.equal(await balanceOf(loser.client), 4_000)

  const repeat = await admin.client.send('POST', `/api/admin/jackpots/${id}/settle`, {})
  assert.equal(repeat.json.already, true)
  assert.equal(await balanceOf(player.client), 19_000 + 5_000_000)
  const wins = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE entry_type = 'bet_win' AND reference_type = 'jackpot_ticket'`,
  )
  assert.equal(wins.rows[0].n, 2)
  const tickets = await admin.client.send('GET', `/api/admin/jackpots/${id}/tickets`)
  const byPhone = Object.fromEntries(tickets.json.data.map((row: { phone: string; correctCount: number; status: string; prizeTzs: number }) => [row.phone, row]))
  assert.equal(byPhone[player.number].correctCount, 8)
  assert.equal(byPhone[player.number].status, 'won')
  assert.equal(byPhone[player.number].prizeTzs, 5_000_000)
  assert.equal(byPhone[second.number].correctCount, 7)
  assert.equal(byPhone[second.number].prizeTzs, 50_000)
  assert.equal(byPhone[loser.number].status, 'lost')
  assert.equal(byPhone[loser.number].prizeTzs, 0)
})

test('an entered 1X2 settles an open fixture, and cancelling refunds each stake once', async () => {
  const { admin, player } = await adminAndPlayer(8_000)
  const ids = await matches(admin.client, 8)
  const created = await admin.client.send('POST', '/api/admin/jackpots', powerBody(ids))
  const id = created.json.id as string
  const picks = ['home', 'draw', 'away', 'home', 'home', 'draw', 'away', 'home']
  assert.equal((await player.client.send('POST', `/api/jackpots/${id}/tickets`, { selections: picks, idempotencyKey: randomUUID() })).status, 200)
  const results = picks.map((result, index) => ({ position: index + 1, result }))
  const settled = await admin.client.send('POST', `/api/admin/jackpots/${id}/settle`, { results })
  assert.equal(settled.status, 200, JSON.stringify(settled.json))
  assert.equal(settled.json.paid, 1)
  assert.equal(await balanceOf(player.client), 7_000 + 5_000_000)

  const otherIds = await matches(admin.client, 8)
  const other = await admin.client.send('POST', '/api/admin/jackpots', powerBody(otherIds))
  const otherId = other.json.id as string
  assert.equal((await player.client.send('POST', `/api/jackpots/${otherId}/tickets`, { selections: picks, idempotencyKey: randomUUID() })).status, 200)
  const before = await balanceOf(player.client)
  const cancelled = await admin.client.send('POST', `/api/admin/jackpots/${otherId}/cancel`, { reason: 'Mechi zimeahirishwa' })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.refunded, 1)
  assert.equal(await balanceOf(player.client), before + 1000)
  const twice = await admin.client.send('POST', `/api/admin/jackpots/${otherId}/cancel`, { reason: 'Mechi zimeahirishwa' })
  assert.equal(twice.json.already, true)
  assert.equal(await balanceOf(player.client), before + 1000)
  const refunds = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE entry_type = 'refund' AND reference_type = 'jackpot_ticket' AND user_id = $1`,
    [player.id],
  )
  assert.equal(refunds.rows[0].n, 1)

  await pool.query(`UPDATE matches SET status = 'postponed' WHERE id = ANY($1::int[])`, [ids])
  const allVoidIds = await matches(admin.client, 8)
  const postponed = await admin.client.send('POST', '/api/admin/jackpots', powerBody(allVoidIds))
  const postponedId = postponed.json.id as string
  assert.equal((await player.client.send('POST', `/api/jackpots/${postponedId}/tickets`, { selections: picks, idempotencyKey: randomUUID() })).status, 200)
  await pool.query(`UPDATE matches SET status = 'postponed' WHERE id = ANY($1::int[])`, [allVoidIds])
  const stakeBefore = await balanceOf(player.client)
  const refunded = await admin.client.send('POST', `/api/admin/jackpots/${postponedId}/settle`, {})
  assert.equal(refunded.status, 200, JSON.stringify(refunded.json))
  assert.equal(refunded.json.allVoid, true)
  assert.equal(refunded.json.refunded, 1)
  assert.equal(refunded.json.paid, 0)
  assert.equal(await balanceOf(player.client), stakeBefore + 1000)
})
