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
if (!dbName.includes('test')) throw new Error(`Refusing to run zungusha tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')
const {
  chooseReward,
  pickByWeight,
  rollFromHash,
  segmentIndexFor,
  setZungushaUnitsForTests,
  ZUNGUSHA_REWARDS,
  zungushaHash,
  zungushaPayout,
} = await import('./zungusha/fairness.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 2600

function nextPhone() {
  n += 1
  return phone(n)
}

function queue(values: number[]) {
  let i = 0
  setZungushaUnitsForTests(() => values[i++] ?? 0)
}

function wheel() {
  return ZUNGUSHA_REWARDS.map((reward) => ({
    id: reward.rewardKey,
    weight: reward.weight,
    segmentCount: reward.segmentCount,
    isLost: reward.isLost,
  }))
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  setZungushaUnitsForTests(null)
  operatorConfig.zungushaEnabled = true
  operatorConfig.zungushaSpinCost = 500
  operatorConfig.zungushaMinStake = 100
  operatorConfig.zungushaMaxStake = 100_000
  operatorConfig.zungushaMaxPayout = 5_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`UPDATE zungusha_budget SET budget_tzs = 25000, total_bets_tzs = 0, total_payouts_tzs = 0, enabled = false`)
  for (const reward of ZUNGUSHA_REWARDS) {
    await pool.query(
      `INSERT INTO zungusha_rewards (reward_key, label, amount_tzs, segment_count, weight, color, is_lost, is_active, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
       ON CONFLICT (reward_key) DO UPDATE
         SET label = EXCLUDED.label, amount_tzs = EXCLUDED.amount_tzs, segment_count = EXCLUDED.segment_count,
             weight = EXCLUDED.weight, color = EXCLUDED.color, is_lost = EXCLUDED.is_lost,
             is_active = true, display_order = EXCLUDED.display_order`,
      [reward.rewardKey, reward.label, reward.amountTzs, reward.segmentCount, reward.weight, reward.color, reward.isLost, reward.displayOrder],
    )
  }
  await pool.query(
    `DELETE FROM zungusha_rewards WHERE reward_key <> ALL($1::text[])`,
    [ZUNGUSHA_REWARDS.map((reward) => reward.rewardKey)],
  )
})

after(async () => {
  setZungushaUnitsForTests(null)
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
    direction: 'credit', amountTzs: balance, reason: 'zungusha test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

test('seed weights pay about 90 percent of a 500 spin and the pointer index follows the slices', () => {
  const rows = wheel()
  const total = rows.reduce((sum, row) => sum + row.weight, 0)
  const ev = rows.reduce((sum, row) => sum + (row.isLost ? 0 : ZUNGUSHA_REWARDS.find((item) => item.rewardKey === row.id)!.amountTzs * row.weight), 0) / total
  assert.ok(Math.abs(ev - 450) < 0.01, String(ev))
  assert.equal(pickByWeight(rows, 0).id, 'lost')
  assert.equal(pickByWeight(rows, 0.4).id, 'tsh-200')
  assert.equal(pickByWeight(rows, 0.6).id, 'tsh-500')
  assert.equal(pickByWeight(rows, 0.99995).id, 'iphone')
  assert.equal(segmentIndexFor(rows, 'lost', 0), 0)
  assert.equal(segmentIndexFor(rows, 'lost', 0.99), 5)
  assert.equal(segmentIndexFor(rows, 'tsh-500', 0), 9)
  assert.equal(zungushaPayout(1_500_000, false, 1000), 1000)
  assert.equal(zungushaPayout(500, true, 5_000_000), 0)
  const forced = chooseReward(rows, 0.6, { rate: 0.98, draw: 0 })
  assert.equal(forced.forced, true)
  assert.equal(forced.reward.id, 'lost')
  const escaped = chooseReward(rows, 0.6, { rate: 0.98, draw: 0.99 })
  assert.equal(escaped.forced, false)
  assert.equal(escaped.reward.id, 'tsh-500')
  const open = chooseReward(rows.filter((row) => !row.isLost), 0, { rate: 0.98, draw: 0 })
  assert.equal(open.forced, false)
  assert.notEqual(open.reward.id, 'lost')
})

test('a weighted prize pays its amount, a replay does not debit again, and a lost slice pays nothing', async () => {
  const { player } = await adminAndPlayer(20_000)
  queue([0, 0])
  const lostKey = randomUUID()
  const lost = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: lostKey })
  assert.equal(lost.status, 200, JSON.stringify(lost.json))
  assert.equal(lost.json.spin.reward.isLost, true)
  assert.equal(lost.json.spin.reward.label, 'LOST')
  assert.equal(lost.json.spin.payoutTzs, 0)
  assert.equal(lost.json.spin.segmentIndex, 0)
  assert.equal(lost.json.spin.nonce, 0)
  assert.equal(lost.json.spin.forced, undefined)
  assert.equal(lost.json.balanceTzs, 19_500)
  assert.equal(JSON.stringify(lost.json).includes('weight'), false)
  assert.equal(JSON.stringify(lost.json).includes('forced'), false)

  queue([0.6, 0])
  const winKey = randomUUID()
  const win = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: winKey })
  assert.equal(win.status, 200, JSON.stringify(win.json))
  assert.equal(win.json.spin.reward.isLost, false)
  assert.equal(win.json.spin.reward.label, '500')
  assert.equal(win.json.spin.reward.amount, 500)
  assert.equal(win.json.spin.payoutTzs, 500)
  assert.equal(win.json.spin.segmentIndex, 9)
  assert.equal(win.json.spin.nonce, 1)
  assert.equal(win.json.balanceTzs, 19_500)
  const replay = await player.client.send('POST', '/api/zungusha/spin', {
    stakeTzs: 10000, idempotencyKey: winKey,
  })
  assert.equal(replay.json.duplicate, true)
  assert.equal(replay.json.spin.reward.label, '500')
  assert.equal(replay.json.balanceTzs, win.json.balanceTzs)

  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'zungusha'`,
    [player.id],
  )
  const credits = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win' AND reference_type = 'zungusha'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 2)
  assert.equal(credits.rows[0].n, 1)
  const budget = await pool.query<{ bets: string; payouts: string }>(
    `SELECT total_bets_tzs::text AS bets, total_payouts_tzs::text AS payouts FROM zungusha_budget`,
  )
  assert.equal(budget.rows[0].bets, '1000')
  assert.equal(budget.rows[0].payouts, '500')

  const board = await player.client.send('GET', '/api/zungusha')
  assert.equal(board.json.limits.spinCost, 500)
  assert.equal(board.json.limits.minStake, 100)
  assert.equal(board.json.limits.maxStake, 100_000)
  assert.equal(board.json.limits.budgetEnabled, false)
  assert.equal(board.json.limits.budgetTzs, undefined)
  assert.equal(board.json.rewards.length, 8)
  assert.equal(JSON.stringify(board.json).includes('weight'), false)
  assert.equal(board.json.winners.length, 1)
  assert.equal(board.json.winners[0].rewardLabel, '500')
  assert.equal(board.json.winners[0].amountWon, 500)
})

test('the maximum payout caps a prize and an unpinned roll matches the hash', async () => {
  const { player } = await adminAndPlayer(20_000)
  operatorConfig.zungushaMaxPayout = 1000
  queue([0.99995, 0])
  const capped = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: randomUUID() })
  assert.equal(capped.status, 200, JSON.stringify(capped.json))
  assert.equal(capped.json.spin.reward.label, 'iPhone 17 Pro Max')
  assert.equal(capped.json.spin.reward.isLost, false)
  assert.equal(capped.json.spin.payoutTzs, 1000)
  assert.equal(capped.json.balanceTzs, 20_000 - 500 + 1000)
  operatorConfig.zungushaMaxPayout = 5_000_000

  setZungushaUnitsForTests(null)
  const fair = await player.client.send('POST', '/api/zungusha/spin', {
    stakeTzs: 500, idempotencyKey: randomUUID(), clientSeed: 'wheel',
  })
  assert.equal(fair.status, 200, JSON.stringify(fair.json))
  const row = await pool.query<{ hash: string; server_seed: string; roll: string; reward_key: string; segment_index: number; forced: boolean }>(
    `SELECT s.hash, s.server_seed, s.roll::text AS roll, r.reward_key, s.segment_index, s.forced
       FROM zungusha_spins s
       JOIN zungusha_rewards r ON r.id = s.reward_id
      WHERE s.id = $1`,
    [fair.json.spin.id],
  )
  assert.equal(row.rows[0].hash, zungushaHash(row.rows[0].server_seed, 'wheel', 1))
  assert.equal(row.rows[0].forced, false)
  const rows = await pool.query<{ id: string; reward_key: string; weight: string; segment_count: number; is_lost: boolean }>(
    `SELECT id, reward_key, weight::text AS weight, segment_count, is_lost
       FROM zungusha_rewards WHERE is_active ORDER BY display_order, reward_key`,
  )
  const active = rows.rows.map((item) => ({
    id: item.id,
    weight: Number(item.weight),
    segmentCount: item.segment_count,
    isLost: item.is_lost,
    rewardKey: item.reward_key,
  }))
  const unit = rollFromHash(row.rows[0].hash, 0)
  assert.ok(Math.abs(Number(row.rows[0].roll) - unit) < 1e-9)
  const picked = chooseReward(active, unit)
  const expectedKey = active.find((item) => item.id === picked.reward.id)?.rewardKey
  assert.equal(row.rows[0].reward_key, expectedKey)
  const index = segmentIndexFor(active, picked.reward.id, rollFromHash(row.rows[0].hash, 13))
  assert.equal(row.rows[0].segment_index, index)
})

test('zungusha rejects a short stake, an empty wallet, a missing token, and a switched-off game', async () => {
  const { admin, player } = await adminAndPlayer(500)
  const small = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 50, idempotencyKey: randomUUID() })
  assert.equal(small.status, 400)
  const huge = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 100_001, idempotencyKey: randomUUID() })
  assert.equal(huge.status, 400)
  const broke = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 1000, idempotencyKey: randomUUID() })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')
  const missing = await app.inject({
    method: 'POST',
    url: '/api/zungusha/spin',
    headers: { cookie: player.client.header() },
    payload: { stakeTzs: 100, idempotencyKey: randomUUID() },
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')

  const denied = await player.client.send('GET', '/api/admin/zungusha')
  assert.equal(denied.status, 403)
  const deniedPatch = await player.client.send('PATCH', '/api/admin/zungusha/budget', { enabled: true })
  assert.equal(deniedPatch.status, 403)

  operatorConfig.zungushaEnabled = false
  const off = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 100, idempotencyKey: randomUUID() })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'game_disabled')
  operatorConfig.zungushaEnabled = true

  const bad = await admin.client.send('PATCH', '/api/admin/zungusha/settings', { zungushaMinStake: 50 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/zungusha/settings', {
    zungushaMinStake: 200, zungushaEnabled: false,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.zungushaMinStake, 200)
  assert.equal(saved.json.zungushaEnabled, false)
  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.zungusha.settings'`,
  )
  assert.equal(audit.rows[0].n, 1)
  operatorConfig.zungushaMinStake = 100
  operatorConfig.zungushaEnabled = true
})

test('an admin can edit a prize, and a drained budget forces a loss', async () => {
  const { admin, player } = await adminAndPlayer(20_000)
  const board = await admin.client.send('GET', '/api/admin/zungusha')
  assert.equal(board.status, 200, JSON.stringify(board.json))
  const prize = board.json.rewards.find((reward: { rewardKey: string }) => reward.rewardKey === 'tsh-500')
  const edited = await admin.client.send('PATCH', `/api/admin/zungusha/rewards/${prize.id}`, {
    label: 'NUSU',
    amountTzs: 800,
    segmentCount: prize.segmentCount,
    weight: prize.weight,
    color: prize.color,
    isLost: false,
    isActive: true,
    displayOrder: prize.displayOrder,
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.json))
  assert.equal(edited.json.reward.label, 'NUSU')
  assert.equal(edited.json.reward.amount, 800)
  const rewardAudit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.zungusha.rewards'`,
  )
  assert.equal(rewardAudit.rows[0].n, 1)

  const added = await admin.client.send('POST', '/api/admin/zungusha/rewards', {})
  assert.equal(added.status, 200, JSON.stringify(added.json))
  assert.equal(added.json.reward.label, 'NEW')
  const removed = await admin.client.send('DELETE', `/api/admin/zungusha/rewards/${added.json.reward.id}`)
  assert.equal(removed.status, 200, JSON.stringify(removed.json))

  queue([0.6, 0])
  const open = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: randomUUID() })
  assert.equal(open.status, 200, JSON.stringify(open.json))
  assert.equal(open.json.spin.reward.label, 'NUSU')
  assert.equal(open.json.spin.payoutTzs, 800)
  assert.equal(open.json.balanceTzs, 20_300)

  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/admin/zungusha/budget',
    headers: { cookie: admin.client.header() },
    payload: { enabled: true },
  })
  assert.equal(missing.statusCode, 403)
  const bad = await admin.client.send('PATCH', '/api/admin/zungusha/budget', { budgetTzs: -1 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/zungusha/budget', { enabled: true, budgetTzs: 25_000 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.enabled, true)
  assert.equal(saved.json.lossRate, 0.8)
  assert.equal(saved.json.payoutCap, 13_750)

  await pool.query(`UPDATE zungusha_budget SET total_payouts_tzs = 25000, total_bets_tzs = 0, enabled = true`)
  const danger = await admin.client.send('GET', '/api/admin/zungusha')
  assert.equal(danger.json.budget.lossRate, 0.98)
  assert.equal(danger.json.budget.healthLabel, 'danger')

  queue([0, 0.6, 0])
  const forced = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: randomUUID() })
  assert.equal(forced.status, 200, JSON.stringify(forced.json))
  assert.equal(forced.json.spin.reward.isLost, true)
  assert.equal(forced.json.spin.payoutTzs, 0)
  assert.equal(forced.json.spin.forced, undefined)
  const forcedRow = await pool.query<{ forced: boolean }>(
    `SELECT forced FROM zungusha_spins WHERE id = $1`,
    [forced.json.spin.id],
  )
  assert.equal(forcedRow.rows[0].forced, true)

  queue([0.99, 0.6, 0])
  const paidKey = randomUUID()
  const paid = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: paidKey })
  assert.equal(paid.status, 200, JSON.stringify(paid.json))
  assert.equal(paid.json.spin.reward.label, 'NUSU')
  assert.equal(paid.json.spin.payoutTzs, 800)
  const paidRow = await pool.query<{ forced: boolean }>(
    `SELECT forced FROM zungusha_spins WHERE id = $1`,
    [paid.json.spin.id],
  )
  assert.equal(paidRow.rows[0].forced, false)
  const replay = await player.client.send('POST', '/api/zungusha/spin', { stakeTzs: 500, idempotencyKey: paidKey })
  assert.equal(replay.json.duplicate, true)
  const counters = await pool.query<{ bets: string; payouts: string }>(
    `SELECT total_bets_tzs::text AS bets, total_payouts_tzs::text AS payouts FROM zungusha_budget`,
  )
  assert.equal(counters.rows[0].bets, '1000')
  assert.equal(counters.rows[0].payouts, '25800')

  const reset = await admin.client.send('PATCH', '/api/admin/zungusha/budget', { resetCounters: true, enabled: false })
  assert.equal(reset.status, 200, JSON.stringify(reset.json))
  assert.equal(reset.json.enabled, false)
  assert.equal(reset.json.totalBetsTzs, 0)
  assert.equal(reset.json.totalPayoutsTzs, 0)
  assert.equal(reset.json.lossRate, 0.8)
  const budgetAudit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.zungusha.budget'`,
  )
  assert.equal(budgetAudit.rows[0].n, 2)

  const latest = await admin.client.send('GET', '/api/admin/zungusha')
  const only = latest.json.rewards[0]
  const blocked = await admin.client.send('PATCH', `/api/admin/zungusha/rewards/${only.id}`, {
    label: only.label,
    amountTzs: only.amount,
    segmentCount: only.segmentCount,
    weight: only.weight,
    color: only.color,
    isLost: only.isLost,
    isActive: false,
    displayOrder: only.displayOrder,
  })
  for (const reward of latest.json.rewards.slice(1)) {
    await admin.client.send('PATCH', `/api/admin/zungusha/rewards/${reward.id}`, {
      label: reward.label,
      amountTzs: reward.amount,
      segmentCount: reward.segmentCount,
      weight: reward.weight,
      color: reward.color,
      isLost: reward.isLost,
      isActive: false,
      displayOrder: reward.displayOrder,
    })
  }
  assert.equal(blocked.status, 200, JSON.stringify(blocked.json))
  const last = await admin.client.send('PATCH', `/api/admin/zungusha/rewards/${latest.json.rewards.at(-1).id}`, {
    label: latest.json.rewards.at(-1).label,
    amountTzs: latest.json.rewards.at(-1).amount,
    segmentCount: latest.json.rewards.at(-1).segmentCount,
    weight: latest.json.rewards.at(-1).weight,
    color: latest.json.rewards.at(-1).color,
    isLost: latest.json.rewards.at(-1).isLost,
    isActive: false,
    displayOrder: latest.json.rewards.at(-1).displayOrder,
  })
  assert.equal(last.status, 400)
})
