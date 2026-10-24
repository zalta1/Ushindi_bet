import assert from 'node:assert/strict'
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
if (!dbName.includes('test')) throw new Error(`Refusing to run admin tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { loadPersistedSettings } = await import('./admin/settings-store.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 400

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
  await pool.query(`TRUNCATE banners, announcements, notifications, auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
})

after(async () => {
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201)
  return { client, number, id: created.json.user.id as string }
}

test('only player and admin remain, and the owner phone is admin when present', async () => {
  const labels = await pool.query<{ enumlabel: string }>(
    `SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'account_role'
      ORDER BY e.enumsortorder`,
  )
  assert.deepEqual(labels.rows.map((row) => row.enumlabel), ['player', 'admin'])

  const owner = '+255743500257'
  await pool.query(
    `INSERT INTO users (phone, password_hash, full_name, dob, role)
     VALUES ($1, 'x', 'Owner Account', '1990-01-01', 'player')`,
    [owner],
  )
  await pool.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [owner])
  const row = await pool.query<{ role: string }>(`SELECT role FROM users WHERE phone = $1`, [owner])
  assert.equal(row.rows[0].role, 'admin')
})

test('overview counts are real and settings survive a reload', async () => {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const overview = await admin.client.send('GET', '/api/admin/overview')
  assert.equal(overview.status, 200)
  assert.equal(overview.json.users, 2)
  assert.equal(overview.json.betsToday, 0)
  assert.equal(overview.json.revenueTzs, 0)
  const live = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM matches WHERE status IN ('live', 'inplay')`)
  assert.equal(overview.json.activeMatches, live.rows[0].n)
  assert.equal(overview.json.newest.length, 2)

  const saved = await admin.client.send('PATCH', '/api/admin/config', { minDeposit: 45000, withdrawalsEnabled: false })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.minDeposit, 45000)
  operatorConfig.minDeposit = 30000
  operatorConfig.withdrawalsEnabled = true
  await loadPersistedSettings(cfg)
  assert.equal(operatorConfig.minDeposit, 45000)
  assert.equal(operatorConfig.withdrawalsEnabled, false)

  const stored = await pool.query<{ value: number }>(`SELECT value FROM settings WHERE key = 'minDeposit'`)
  assert.equal(stored.rows[0].value, 45000)
})

test('balance changes go through the ledger and keep a reason', async () => {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()

  const missing = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, { direction: 'credit', amountTzs: 1000, reason: 'no' })
  assert.equal(missing.status, 400)

  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit',
    amountTzs: 1500,
    reason: 'goodwill top up',
  })
  assert.equal(credited.status, 200)
  assert.equal(credited.json.balanceTzs, 1500)

  const wallet = await pool.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [player.id])
  assert.equal(wallet.rows[0].balance_tzs, '1500')
  const note = await pool.query<{ reason: string; entry_type: string }>(
    `SELECT n.reason, e.entry_type
       FROM ledger_notes n
       JOIN ledger_entries e ON e.id = n.ledger_id
      WHERE e.user_id = $1`,
    [player.id],
  )
  assert.equal(note.rows[0].reason, 'goodwill top up')
  assert.equal(note.rows[0].entry_type, 'adjustment')

  const broke = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'debit',
    amountTzs: 5000,
    reason: 'too much',
  })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')
  const still = await pool.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [player.id])
  assert.equal(still.rows[0].balance_tzs, '1500')
})

test('force logout, soft close, and read-only impersonation are audited', async () => {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()

  const kicked = await admin.client.send('POST', `/api/admin/users/${player.id}/force-logout`, { reason: 'shared device' })
  assert.equal(kicked.status, 200)
  assert.equal((await player.client.send('GET', '/api/auth/me')).status, 401)
  const again = await player.client.send('POST', '/api/auth/login', { phone: player.number, password })
  assert.equal(again.status, 200)

  const viewed = await admin.client.send('POST', `/api/admin/users/${player.id}/impersonate`, { reason: 'support check' })
  assert.equal(viewed.status, 200)
  assert.equal(viewed.json.readOnly, true)
  const me = await admin.client.send('GET', '/api/auth/me')
  assert.equal(me.json.user.phone, player.number)
  assert.equal(me.json.user.readOnly, true)
  assert.equal(me.json.user.admin, false)
  const blocked = await admin.client.send('POST', '/api/deposits', { amount: 30000, phone: player.number })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.json.error, 'read_only')
  const stopped = await admin.client.send('POST', '/api/auth/impersonation/stop', {})
  assert.equal(stopped.status, 200)
  const restored = await admin.client.send('GET', '/api/auth/me')
  assert.equal(restored.json.user.phone, admin.number)
  assert.equal(restored.json.user.admin, true)

  const closed = await admin.client.send('POST', `/api/admin/users/${player.id}/close`, { reason: 'duplicate account' })
  assert.equal(closed.status, 200)
  const stillThere = await pool.query(`SELECT id, closed_at FROM users WHERE id = $1`, [player.id])
  assert.equal(stillThere.rowCount, 1)
  assert.ok(stillThere.rows[0].closed_at)
  const denied = await player.client.send('POST', '/api/auth/login', { phone: player.number, password })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error, 'account_closed')

  const log = await admin.client.send('GET', '/api/admin/audit')
  const actions = (log.json.data as { action: string }[]).map((row) => row.action)
  assert.ok(actions.includes('admin.user.force_logout'))
  assert.ok(actions.includes('admin.impersonate.start'))
  assert.ok(actions.includes('admin.impersonate.stop'))
  assert.ok(actions.includes('admin.user.close'))
})

test('reconciliation matches the ledger and content writes are audited', async () => {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const run = await admin.client.send('POST', '/api/admin/reconcile/wallets', {})
  assert.equal(run.status, 200)
  assert.equal(run.json.mismatches, 0)
  assert.equal(run.json.walletsChecked, 1)

  const banner = await admin.client.send('POST', '/api/admin/banners', {
    title: 'Karibu',
    imageUrl: 'https://example.com/banner.png',
    active: true,
    sortOrder: 1,
  })
  assert.equal(banner.status, 200)
  const listed = await admin.client.send('GET', '/api/banners')
  assert.equal(listed.json.data.length, 1)

  const note = await admin.client.send('POST', '/api/admin/announcements', {
    messageSw: 'Karibu Ushindi',
    messageEn: 'Welcome to Ushindi',
  })
  assert.equal(note.status, 200)
  const sent = await admin.client.send('POST', '/api/admin/notifications', {
    title: 'Habari',
    body: 'Salio lako liko tayari.',
    phone: '',
  })
  assert.equal(sent.status, 200)
  const flags = await admin.client.send('GET', '/api/admin/fraud-flags')
  assert.equal(flags.status, 200)
  assert.ok(Array.isArray(flags.json.data))
})
