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
if (!dbName.includes('test')) throw new Error(`Refusing to run penalty tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')
const {
  keeperFor,
  outcomeFromRolls,
  PENALTY_ZONES,
  penaltyHash,
  penaltyPayout,
  rollFromHash,
  setPenaltyUnitsForTests,
} = await import('./penalty/fairness.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 2500

function nextPhone() {
  n += 1
  return phone(n)
}

function queue(values: number[]) {
  let i = 0
  setPenaltyUnitsForTests(() => values[i++] ?? 0)
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  setPenaltyUnitsForTests(null)
  operatorConfig.penaltyEnabled = true
  operatorConfig.penaltyMinStake = 500
  operatorConfig.penaltyMaxStake = 100_000
  operatorConfig.penaltyMaxPayout = 2_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`UPDATE penalty_budget SET budget_tzs = 25000, total_bets_tzs = 0, total_payouts_tzs = 0, enabled = false`)
  for (const zone of PENALTY_ZONES) {
    await pool.query(
      `UPDATE penalty_zones
          SET label = $2, multiplier = $3, win_chance = $4, display_order = $5, is_active = true
        WHERE zone_key = $1`,
      [zone.zoneKey, zone.label, zone.multiplier, zone.winChance, zone.displayOrder],
    )
  }
})

after(async () => {
  setPenaltyUnitsForTests(null)
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  return { client, number, id: created.json.user.id as string }
}

async function adminAndPlayer(balance = 20_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit', amountTzs: balance, reason: 'penalty test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

test('zone prices stay near 90 percent RTP and the hash roll decides the kick', () => {
  for (const zone of PENALTY_ZONES) {
    const rtp = zone.winChance * zone.multiplier
    assert.ok(rtp > 0.89 && rtp < 0.92, `${zone.zoneKey} ${rtp}`)
  }
  assert.equal(outcomeFromRolls(0.18, 0, 0.9), 'goal')
  assert.equal(outcomeFromRolls(0.18, 0.18, 0.1), 'saved')
  assert.equal(outcomeFromRolls(0.18, 0.5, 0.1), 'saved')
  assert.equal(outcomeFromRolls(0.18, 0.5, 0.9), 'miss')
  assert.equal(keeperFor('top-left', 'saved', 0.99), 'top-left')
  assert.equal(keeperFor('top-left', 'goal', 0), 'top-center')
  assert.notEqual(keeperFor('top-left', 'miss', 0.99), 'top-left')
  assert.equal(penaltyPayout(500, 5, 2_000_000), 2500)
  assert.equal(penaltyPayout(500, 35, 2_000_000), 17500)
  assert.equal(penaltyPayout(500, 5, 1000), 1000)
  const hash = penaltyHash('server', 'ushindi', 0)
  const roll = rollFromHash(hash)
  assert.equal(roll, rollFromHash(hash, 0))
  assert.ok(roll >= 0 && roll < 1)
  assert.notEqual(rollFromHash(hash, 13), undefined)
})

test('a top-left goal pays 5x, a replay does not debit again, and a save or a miss pays nothing', async () => {
  const { player } = await adminAndPlayer(20_000)
  queue([0, 0.1, 0.2])
  const goalKey = randomUUID()
  const goal = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: goalKey,
  })
  assert.equal(goal.status, 200, JSON.stringify(goal.json))
  assert.equal(goal.json.shot.outcome, 'goal')
  assert.equal(goal.json.shot.zoneKey, 'top-left')
  assert.notEqual(goal.json.shot.keeperZone, 'top-left')
  assert.equal(goal.json.shot.multiplier, 5)
  assert.equal(goal.json.shot.payoutTzs, 2500)
  assert.equal(goal.json.shot.nonce, 0)
  assert.equal(goal.json.shot.winChance, undefined)
  assert.equal(goal.json.balanceTzs, 20_000 - 500 + 2500)
  assert.equal(JSON.stringify(goal.json.shot).includes('winChance'), false)
  const goalReplay = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'bottom-center', stakeTzs: 10000, idempotencyKey: goalKey,
  })
  assert.equal(goalReplay.json.duplicate, true)
  assert.equal(goalReplay.json.shot.outcome, 'goal')
  assert.equal(goalReplay.json.balanceTzs, goal.json.balanceTzs)

  queue([0.99, 0.1, 0.2])
  const saved = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.shot.outcome, 'saved')
  assert.equal(saved.json.shot.keeperZone, 'top-left')
  assert.equal(saved.json.shot.payoutTzs, 0)
  assert.equal(saved.json.shot.nonce, 1)
  assert.equal(saved.json.balanceTzs, 22_000 - 500)

  queue([0.99, 0.9, 0.2])
  const missed = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(missed.status, 200, JSON.stringify(missed.json))
  assert.equal(missed.json.shot.outcome, 'miss')
  assert.notEqual(missed.json.shot.keeperZone, 'top-left')
  assert.equal(missed.json.shot.payoutTzs, 0)
  assert.equal(missed.json.balanceTzs, 21_500 - 500)

  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'penalty'`,
    [player.id],
  )
  const credits = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win' AND reference_type = 'penalty'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 3)
  assert.equal(credits.rows[0].n, 1)
  const budget = await pool.query<{ bets: string; payouts: string }>(
    `SELECT total_bets_tzs::text AS bets, total_payouts_tzs::text AS payouts FROM penalty_budget`,
  )
  assert.equal(budget.rows[0].bets, '1500')
  assert.equal(budget.rows[0].payouts, '2500')

  const stored = await pool.query<{ hash: string; server_seed: string; client_seed: string; nonce: number; roll: string }>(
    `SELECT hash, server_seed, client_seed, nonce, roll::text AS roll FROM penalty_shots WHERE user_id = $1 ORDER BY nonce`,
    [player.id],
  )
  assert.equal(stored.rows[0].hash, penaltyHash(stored.rows[0].server_seed, stored.rows[0].client_seed, stored.rows[0].nonce))

  const board = await player.client.send('GET', '/api/penalty')
  assert.equal(board.json.limits.budgetEnabled, false)
  assert.equal(board.json.limits.maxPayout, 2_000_000)
  assert.equal(board.json.limits.step, 500)
  assert.equal(board.json.limits.budgetTzs, undefined)
  assert.equal(board.json.history.length, 3)
  assert.equal(JSON.stringify(board.json).includes('winChance'), false)
  assert.equal(JSON.stringify(board.json).includes('budgetTzs'), false)
})

test('the maximum payout caps a goal and the stored hash matches an unpinned roll', async () => {
  const { player } = await adminAndPlayer(20_000)
  operatorConfig.penaltyMaxPayout = 1000
  queue([0, 0.2, 0.2])
  const capped = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(capped.status, 200, JSON.stringify(capped.json))
  assert.equal(capped.json.shot.outcome, 'goal')
  assert.equal(capped.json.shot.payoutTzs, 1000)
  assert.equal(capped.json.balanceTzs, 20_000 - 500 + 1000)
  operatorConfig.penaltyMaxPayout = 2_000_000

  setPenaltyUnitsForTests(null)
  const fair = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'mid-center', stakeTzs: 500, idempotencyKey: randomUUID(), clientSeed: 'pitch',
  })
  assert.equal(fair.status, 200, JSON.stringify(fair.json))
  const row = await pool.query<{ hash: string; server_seed: string; roll: string; outcome: string; win_chance: string }>(
    `SELECT hash, server_seed, roll::text AS roll, outcome, win_chance::text AS win_chance
       FROM penalty_shots WHERE id = $1`,
    [fair.json.shot.id],
  )
  assert.equal(row.rows[0].hash, penaltyHash(row.rows[0].server_seed, 'pitch', 1))
  const expected = rollFromHash(row.rows[0].hash)
  assert.ok(Math.abs(Number(row.rows[0].roll) - expected) < 1e-9)
  const goal = expected < Number(row.rows[0].win_chance)
  assert.equal(row.rows[0].outcome === 'goal', goal)
})

test('penalty rejects an empty zone, a stranger zone, a short stake, a short wallet, a missing token, and a switched-off game', async () => {
  const { admin, player } = await adminAndPlayer(500)
  const empty = await player.client.send('POST', '/api/penalty/shoot', { stakeTzs: 500, idempotencyKey: randomUUID() })
  assert.equal(empty.status, 400)
  const unknown = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'nowhere', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(unknown.status, 400)
  const small = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(small.status, 400)
  const broke = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 1000, idempotencyKey: randomUUID(),
  })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/penalty/shoot',
    headers: { cookie: player.client.header() },
    payload: { zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID() },
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')

  const denied = await player.client.send('GET', '/api/admin/penalty')
  assert.equal(denied.status, 403)
  const deniedPatch = await player.client.send('PATCH', '/api/admin/penalty/budget', { enabled: true })
  assert.equal(deniedPatch.status, 403)

  await pool.query(`UPDATE penalty_zones SET is_active = false WHERE zone_key = 'top-right'`)
  const inactive = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-right', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(inactive.status, 400)

  operatorConfig.penaltyEnabled = false
  const off = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'game_disabled')
  operatorConfig.penaltyEnabled = true

  const bad = await admin.client.send('PATCH', '/api/admin/penalty/settings', { penaltyMinStake: 50 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/penalty/settings', {
    penaltyMinStake: 1000, penaltyEnabled: false,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.penaltyMinStake, 1000)
  assert.equal(saved.json.penaltyEnabled, false)
  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.penalty.settings'`,
  )
  assert.equal(audit.rows[0].n, 1)
  operatorConfig.penaltyMinStake = 500
  operatorConfig.penaltyEnabled = true
})

test('an admin can edit a zone, and a drained budget still pays a goal', async () => {
  const { admin, player } = await adminAndPlayer(20_000)
  const board = await admin.client.send('GET', '/api/admin/penalty')
  assert.equal(board.status, 200, JSON.stringify(board.json))
  const zones = board.json.zones.map((zone: { zoneKey: string; label: string; multiplier: number; winChance: number; isActive: boolean }) => {
    if (zone.zoneKey !== 'top-left') return zone
    return { ...zone, label: 'Kona', multiplier: 6, winChance: 0, isActive: true }
  })
  const edited = await admin.client.send('PATCH', '/api/admin/penalty/zones', { zones })
  assert.equal(edited.status, 200, JSON.stringify(edited.json))
  const corner = edited.json.zones.find((zone: { zoneKey: string }) => zone.zoneKey === 'top-left')
  assert.equal(corner.multiplier, 6)
  assert.equal(corner.winChance, 0)
  const zoneAudit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.penalty.zones'`,
  )
  assert.equal(zoneAudit.rows[0].n, 1)

  queue([0, 0.1, 0.2])
  const closed = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.json))
  assert.notEqual(closed.json.shot.outcome, 'goal')
  assert.equal(closed.json.shot.payoutTzs, 0)

  const allOff = zones.map((zone: { isActive: boolean }) => ({ ...zone, isActive: false }))
  const blocked = await admin.client.send('PATCH', '/api/admin/penalty/zones', { zones: allOff })
  assert.equal(blocked.status, 400)

  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/admin/penalty/budget',
    headers: { cookie: admin.client.header() },
    payload: { enabled: true },
  })
  assert.equal(missing.statusCode, 403)
  const bad = await admin.client.send('PATCH', '/api/admin/penalty/budget', { budgetTzs: -1 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/penalty/budget', { enabled: true, budgetTzs: 25_000 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.enabled, true)
  assert.equal(saved.json.lossRate, 0.8)
  assert.equal(saved.json.payoutCap, 13_750)

  await pool.query(`UPDATE penalty_budget SET total_payouts_tzs = 25000, total_bets_tzs = 0, enabled = true`)
  await pool.query(`UPDATE penalty_zones SET win_chance = 0.18, multiplier = 5, label = 'Juu Kushoto' WHERE zone_key = 'top-left'`)
  const danger = await admin.client.send('GET', '/api/admin/penalty')
  assert.equal(danger.json.budget.lossRate, 0.98)
  assert.equal(danger.json.budget.healthLabel, 'danger')

  queue([0, 0.1, 0.4])
  const goalKey = randomUUID()
  const paid = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: goalKey,
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.json))
  assert.equal(paid.json.shot.outcome, 'goal')
  assert.equal(paid.json.shot.payoutTzs, 2500)
  const replay = await player.client.send('POST', '/api/penalty/shoot', {
    zoneKey: 'top-left', stakeTzs: 500, idempotencyKey: goalKey,
  })
  assert.equal(replay.json.duplicate, true)
  const counters = await pool.query<{ bets: string; payouts: string }>(
    `SELECT total_bets_tzs::text AS bets, total_payouts_tzs::text AS payouts FROM penalty_budget`,
  )
  assert.equal(counters.rows[0].bets, '500')
  assert.equal(counters.rows[0].payouts, '27500')

  const reset = await admin.client.send('PATCH', '/api/admin/penalty/budget', { resetCounters: true, enabled: false })
  assert.equal(reset.status, 200, JSON.stringify(reset.json))
  assert.equal(reset.json.enabled, false)
  assert.equal(reset.json.totalBetsTzs, 0)
  assert.equal(reset.json.totalPayoutsTzs, 0)
  assert.equal(reset.json.lossRate, 0.8)
  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.penalty.budget'`,
  )
  assert.equal(audit.rows[0].n, 2)
  const listed = await admin.client.send('GET', '/api/admin/penalty')
  assert.equal(listed.json.pnl.goals, 1)
  assert.ok(listed.json.shots.length >= 2)
  assert.equal(typeof listed.json.shots[0].winChance, 'number')
})
