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
if (!dbName.includes('test')) throw new Error(`Refusing to run password reset tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { passwordProblem } = await import('./identity.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
const replacement = 'River-lantern-4'
let n = 900

function nextPhone() {
  n += 1
  return phone(n)
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, passwordResetRateMax: 100, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  operatorConfig.agentWhatsapp = ''
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
})

after(async () => {
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201)
  assert.equal(created.json.user.mustChangePassword, false)
  return { client, number, id: created.json.user.id as string }
}

async function promote(id: string) {
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id])
}

test('admin reset sets a one-time password, revokes sessions, and does not log the secret', async () => {
  const admin = await register()
  await promote(admin.id)
  const player = await register()
  await pool.query(`UPDATE users SET locked_until = now() + interval '1 hour', failed_login_count = 5 WHERE id = $1`, [player.id])

  const reset = await admin.client.send('POST', `/api/admin/users/${player.id}/reset-password`, {})
  assert.equal(reset.status, 200)
  const temporary = reset.json.temporaryPassword as string
  assert.match(temporary, /^[A-HJ-NP-Za-km-z2-9]{16}$/)
  assert.equal(passwordProblem(temporary, player.number), null)
  assert.equal(JSON.stringify(reset.json).includes('password_hash'), false)

  const stored = await pool.query<{ password_hash: string; must_change_password: boolean; locked_until: Date | null }>(
    `SELECT password_hash, must_change_password, locked_until FROM users WHERE id = $1`,
    [player.id],
  )
  assert.equal(stored.rows[0].must_change_password, true)
  assert.equal(stored.rows[0].locked_until, null)
  assert.notEqual(stored.rows[0].password_hash, temporary)
  assert.match(stored.rows[0].password_hash, /^\$argon2id\$/)

  const leakedAudit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE position($1 in payload::text) > 0 OR position($1 in action) > 0`,
    [temporary],
  )
  assert.equal(leakedAudit.rows[0].n, 0)
  const leakedAuth = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_events WHERE position($1 in coalesce(phone, '') || event) > 0`,
    [temporary],
  )
  assert.equal(leakedAuth.rows[0].n, 0)
  const audit = await pool.query<{ actor_user_id: string; payload: { targetUserId: string; targetPhone: string }; created_at: Date }>(
    `SELECT actor_user_id, payload, created_at FROM audit_log WHERE action = 'admin.user.reset_password'`,
  )
  assert.equal(audit.rows.length, 1)
  assert.equal(audit.rows[0].actor_user_id, admin.id)
  assert.equal(audit.rows[0].payload.targetUserId, player.id)
  assert.equal(audit.rows[0].payload.targetPhone, player.number)
  assert.ok(audit.rows[0].created_at instanceof Date)
  const event = await pool.query<{ event: string }>(
    `SELECT event FROM auth_events WHERE user_id = $1 AND event = 'password_reset'`,
    [player.id],
  )
  assert.equal(event.rows.length, 1)

  const stale = await player.client.send('GET', '/api/auth/me')
  assert.equal(stale.status, 401)
  const oldLogin = await player.client.send('POST', '/api/auth/login', { phone: player.number, password })
  assert.equal(oldLogin.status, 401)

  const logged = await player.client.send('POST', '/api/auth/login', { phone: player.number, password: temporary })
  assert.equal(logged.status, 200)
  assert.equal(logged.json.user.mustChangePassword, true)

  const me = await player.client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.json.user.mustChangePassword, true)
  const blocked = await player.client.send('GET', '/api/matches')
  assert.equal(blocked.status, 403)
  assert.equal(blocked.json.error, 'password_change_required')
  const overview = await player.client.send('GET', '/api/admin/overview')
  assert.equal(overview.status, 403)
  assert.equal(overview.json.error, 'password_change_required')
  const anonymous = new Client(app)
  const open = await anonymous.send('GET', '/api/matches')
  assert.equal(open.status, 200)

  const weak = await player.client.send('POST', '/api/auth/set-password', { newPassword: 'short' })
  assert.equal(weak.status, 400)
  assert.equal(weak.json.fields.newPassword, 'min_length')
  const same = await player.client.send('POST', '/api/auth/set-password', { newPassword: temporary })
  assert.equal(same.status, 400)
  assert.equal(same.json.error, 'same_password')
  const still = await player.client.send('GET', '/api/matches')
  assert.equal(still.json.error, 'password_change_required')

  const changed = await player.client.send('POST', '/api/auth/set-password', { newPassword: replacement })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.user.mustChangePassword, false)
  const home = await player.client.send('GET', '/api/matches')
  assert.equal(home.status, 200)
  const denied = await player.client.send('GET', '/api/admin/overview')
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error, 'forbidden')
  const again = await player.client.send('POST', '/api/auth/set-password', { newPassword: 'Another-pass-8' })
  assert.equal(again.status, 409)
  assert.equal(again.json.error, 'password_change_not_required')
  const tempLogin = await new Client(app).send('POST', '/api/auth/login', { phone: player.number, password: temporary })
  assert.equal(tempLogin.status, 401)
  const fresh = await new Client(app).send('POST', '/api/auth/login', { phone: player.number, password: replacement })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.json.user.mustChangePassword, false)
})

test('reset password requires an admin and a CSRF token, and refuses a closed account', async () => {
  const admin = await register()
  await promote(admin.id)
  const player = await register()
  const other = await register()

  const forbidden = await player.client.send('POST', `/api/admin/users/${other.id}/reset-password`, {})
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.json.error, 'forbidden')

  const missing = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${player.id}/reset-password`,
    headers: { cookie: admin.client.header() },
    payload: {},
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')

  const unknown = await admin.client.send('POST', '/api/admin/users/not-a-uuid/reset-password', {})
  assert.equal(unknown.status, 400)
  const absent = await admin.client.send('POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/reset-password', {})
  assert.equal(absent.status, 404)

  await pool.query(`UPDATE users SET closed_at = now() WHERE id = $1`, [player.id])
  const closed = await admin.client.send('POST', `/api/admin/users/${player.id}/reset-password`, {})
  assert.equal(closed.status, 409)
  assert.equal(closed.json.error, 'account_closed')
})

test('an admin can reset their own password and must choose a new one', async () => {
  const admin = await register()
  await promote(admin.id)
  const reset = await admin.client.send('POST', `/api/admin/users/${admin.id}/reset-password`, {})
  assert.equal(reset.status, 200)
  const temporary = reset.json.temporaryPassword as string
  const stale = await admin.client.send('GET', '/api/auth/me')
  assert.equal(stale.status, 401)
  const logged = await admin.client.send('POST', '/api/auth/login', { phone: admin.number, password: temporary })
  assert.equal(logged.status, 200)
  assert.equal(logged.json.user.mustChangePassword, true)
  const overview = await admin.client.send('GET', '/api/admin/overview')
  assert.equal(overview.status, 403)
  assert.equal(overview.json.error, 'password_change_required')
})

test('support contact is empty until a WhatsApp number is saved', async () => {
  const empty = await app.inject({ method: 'GET', url: '/api/support-contact' })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(JSON.parse(empty.body), { whatsapp: null, url: null })
  operatorConfig.agentWhatsapp = '0712 345 678'
  const set = await app.inject({ method: 'GET', url: '/api/support-contact' })
  assert.deepEqual(JSON.parse(set.body), { whatsapp: '0712 345 678', url: 'https://wa.me/255712345678' })
  operatorConfig.agentWhatsapp = 'desk'
  const text = await app.inject({ method: 'GET', url: '/api/support-contact' })
  assert.deepEqual(JSON.parse(text.body), { whatsapp: 'desk', url: null })
})

test('admin password reset is rate limited', async () => {
  const limited = await buildApp({ authRateMax: 1000, registerRateMax: 1000, passwordResetRateMax: 2, redisUrl: '' })
  await limited.ready()
  try {
    const adminClient = new Client(limited)
    const number = nextPhone()
    const created = await adminClient.send('POST', '/api/auth/register', { phone: number, password })
    assert.equal(created.status, 201)
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [created.json.user.id])
    const player = nextPhone()
    const playerClient = new Client(limited)
    const playerCreated = await playerClient.send('POST', '/api/auth/register', { phone: player, password })
    assert.equal(playerCreated.status, 201)
    const id = playerCreated.json.user.id as string
    const first = await adminClient.send('POST', `/api/admin/users/${id}/reset-password`, {})
    const second = await adminClient.send('POST', `/api/admin/users/${id}/reset-password`, {})
    const third = await adminClient.send('POST', `/api/admin/users/${id}/reset-password`, {})
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(third.status, 429)
    assert.equal(third.json.error, 'rate_limited')
    const leaked = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE position($1 in payload::text) > 0 OR position($2 in payload::text) > 0`,
      [first.json.temporaryPassword, second.json.temporaryPassword],
    )
    assert.equal(leaked.rows[0].n, 0)
  } finally {
    await limited.close()
  }
})
