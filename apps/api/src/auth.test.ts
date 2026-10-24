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
if (!dbName.includes('test')) throw new Error(`Refusing to run auth tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { seedSuperAdmin } = await import('./seed.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
let limited: Awaited<ReturnType<typeof buildApp>>
let n = 20

function nextPhone() {
  n += 1
  return phone(n)
}

const password = 'Horse-battery-9'

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  limited = await buildApp({ authRateMax: 2, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
  await limited.ready()
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
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, wallets, users RESTART IDENTITY CASCADE`)
})

after(async () => {
  await app.close()
  await limited.close()
  await closePool()
})

async function register(client: Client, phoneNumber = nextPhone(), extra: Record<string, string> = {}) {
  return client.send('POST', '/api/auth/register', {
    phone: phoneNumber,
    password,
    fullName: 'Asha Juma',
    dob: '1990-01-01',
    ...extra,
  })
}

test('health and public matches stay available without a session', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(health.statusCode, 200)
  const body = health.json()
  assert.equal(body.db, 'up')
  const matches = await app.inject({ method: 'GET', url: '/api/matches' })
  assert.equal(matches.statusCode, 200)
  assert.ok(Array.isArray(matches.json()))
})

test('register, me, logout, and httpOnly cookies', async () => {
  const client = new Client(app)
  const created = await register(client)
  assert.equal(created.status, 201)
  assert.equal(created.json.user?.role, 'player')
  assert.equal(created.json.user?.balanceTzs, 0)
  const setCookie = created.headers['set-cookie']
  const lines = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).map(String)
  const sid = lines.find((line) => line.startsWith('ushindi_sid=')) ?? ''
  const refresh = lines.find((line) => line.startsWith('ushindi_refresh=')) ?? ''
  const csrf = lines.find((line) => line.startsWith('ushindi_csrf=')) ?? ''
  assert.match(sid, /HttpOnly/i)
  assert.match(sid, /SameSite=Lax/i)
  assert.doesNotMatch(sid, /Secure/i)
  assert.match(refresh, /HttpOnly/i)
  assert.match(refresh, /Path=\/api\/auth/i)
  assert.doesNotMatch(csrf, /HttpOnly/i)

  const me = await client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.json.user?.phone, created.json.user?.phone)

  const out = await client.send('POST', '/api/auth/logout')
  assert.equal(out.status, 200)
  const afterLogout = await client.send('GET', '/api/auth/me')
  assert.equal(afterLogout.status, 401)
})

test('rejects bad sign-up input and duplicate phones', async () => {
  const client = new Client(app)
  const young = await client.send('POST', '/api/auth/register', {
    phone: nextPhone(),
    password,
    fullName: 'Asha Juma',
    dob: '2015-01-01',
  })
  assert.equal(young.status, 400)
  assert.equal(young.json.error, 'underage')
  assert.equal(young.json.fields?.dob, 'underage')

  const short = await client.send('POST', '/api/auth/register', {
    phone: '0712345678',
    password: 'Test12345!x',
  })
  assert.equal(short.status, 400)
  assert.equal(short.json.error, 'weak_password')
  assert.equal(short.json.fields?.password, 'min_length')

  const weak = await client.send('POST', '/api/auth/register', {
    phone: nextPhone(),
    password: 'abcdefghijkl',
  })
  assert.equal(weak.status, 400)
  assert.equal(weak.json.error, 'weak_password')
  assert.equal(weak.json.fields?.password, 'letter_and_digit')

  const badPhone = await client.send('POST', '/api/auth/register', {
    phone: '+254712345678',
    password,
    fullName: 'Asha Juma',
    dob: '1990-01-01',
  })
  assert.equal(badPhone.status, 400)
  assert.equal(badPhone.json.error, 'invalid_phone')

  const plain = await client.send('POST', '/api/auth/register', {
    phone: nextPhone(),
    password,
  })
  assert.equal(plain.status, 201)
  assert.equal(plain.json.user?.fullName, '')

  const number = nextPhone()
  assert.equal((await register(client, number)).status, 201)
  const client2 = new Client(app)
  const dup = await register(client2, number)
  assert.equal(dup.status, 409)
  assert.equal(dup.json.error, 'phone_taken')
})

test('login requires CSRF, locks the account, and accepts a good password', async () => {
  const client = new Client(app)
  const number = nextPhone()
  await register(client, number)
  await client.send('POST', '/api/auth/logout')

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { phone: number, password },
  })
  assert.equal(noCsrf.statusCode, 403)
  assert.equal(noCsrf.json().error, 'csrf_invalid')

  for (let i = 0; i < 4; i += 1) {
    const bad = await client.send('POST', '/api/auth/login', { phone: number, password: 'wrong-password-9' })
    assert.equal(bad.status, 401)
    assert.equal(bad.json.error, 'invalid_credentials')
  }
  const locked = await client.send('POST', '/api/auth/login', { phone: number, password: 'wrong-password-9' })
  assert.equal(locked.status, 429)
  assert.equal(locked.json.error, 'locked')
  assert.equal(locked.json.field, 'password')
  assert.ok(locked.json.minutes >= 1 && locked.json.minutes <= 15)
  const stillLocked = await client.send('POST', '/api/auth/login', { phone: number, password })
  assert.equal(stillLocked.status, 429)
  assert.equal(stillLocked.json.error, 'locked')

  await pool.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE phone = $1`, [number])
  const good = await client.send('POST', '/api/auth/login', { phone: number, password })
  assert.equal(good.status, 200)
  assert.equal(good.json.user?.phone, number)
})

test('refresh rotation detects a reused refresh token', async () => {
  const client = new Client(app)
  await register(client)
  const previous = { ...client.jar }
  const rotated = await client.send('POST', '/api/auth/refresh')
  assert.equal(rotated.status, 200)
  assert.notEqual(client.jar.ushindi_refresh, previous.ushindi_refresh)

  const replay = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: {
      cookie: `ushindi_refresh=${previous.ushindi_refresh}; ushindi_csrf=${previous.ushindi_csrf}`,
      'x-csrf-token': previous.ushindi_csrf ?? '',
    },
  })
  assert.equal(replay.statusCode, 401)
  assert.equal(replay.json().error, 'session_reused')

  const burned = await client.send('POST', '/api/auth/refresh')
  assert.equal(burned.status, 401)
})

test('change password revokes the previous session', async () => {
  const client = new Client(app)
  const number = nextPhone()
  await register(client, number)
  const old = client.header()
  const bad = await client.send('POST', '/api/auth/change-password', {
    currentPassword: 'wrong-password-9',
    newPassword: 'Horse-battery-99',
  })
  assert.equal(bad.status, 401)

  const changed = await client.send('POST', '/api/auth/change-password', {
    currentPassword: password,
    newPassword: 'Horse-battery-99',
  })
  assert.equal(changed.status, 200)
  const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: old } })
  assert.equal(stale.statusCode, 401)
  const me = await client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200)

  await client.send('POST', '/api/auth/logout')
  const relog = await client.send('POST', '/api/auth/login', { phone: number, password: 'Horse-battery-99' })
  assert.equal(relog.status, 200)
})

test('admin routes are role checked on the server and audited', async () => {
  const owner = new Client(app)
  const other = new Client(app)
  const ownerPhone = nextPhone()
  const otherPhone = nextPhone()
  await register(owner, ownerPhone)
  await register(other, otherPhone)
  await pool.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [ownerPhone])

  assert.equal((await other.send('GET', '/api/admin/whoami')).status, 403)
  assert.equal((await other.send('GET', '/api/admin/config')).status, 403)
  assert.equal((await owner.send('GET', '/api/admin/config')).status, 200)
  assert.equal((await owner.send('GET', '/api/admin/whoami')).json.role, 'admin')

  const patched = await owner.send('PATCH', '/api/admin/config', { marginBps: 700, minStake: 1000 })
  assert.equal(patched.status, 200)
  const audit = await owner.send('GET', '/api/admin/audit')
  assert.equal(audit.status, 200)
  const entries = audit.json.data as { action: string }[]
  assert.ok(entries.some((entry) => entry.action === 'admin.config.update'))

  const otherId = (await owner.send('GET', '/api/admin/users')).json.data as { id: string; phone: string }[]
  const target = otherId.find((row) => row.phone === otherPhone)
  assert.ok(target)
  const role = await owner.send('POST', `/api/admin/users/${target!.id}/role`, { role: 'admin' })
  assert.equal(role.status, 200)
  assert.equal((await other.send('GET', '/api/admin/users')).status, 200)
  assert.equal((await other.send('PATCH', '/api/admin/config', { marginBps: 650 })).status, 200)
  assert.equal((await other.send('POST', `/api/admin/users/${target!.id}/role`, { role: 'support' })).status, 400)

  const removed = await owner.send('POST', `/api/admin/admins/${target!.id}/revoke`, {})
  assert.equal(removed.status, 200)
  assert.equal((await other.send('GET', '/api/admin/config')).status, 403)

  const ownerRow = await pool.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [ownerPhone])
  const last = await owner.send('POST', `/api/admin/users/${ownerRow.rows[0].id}/role`, { role: 'player' })
  assert.equal(last.status, 409)
  assert.equal(last.json.error, 'last_admin')
})

test('the configured phone is seeded as admin and can sign in', async () => {
  const number = nextPhone()
  await seedSuperAdmin({
    ...cfg,
    adminPhone: '',
    superAdminPhone: number,
    adminPassword: '',
    superAdminPassword: password,
    superAdminName: 'Ushindi Admin',
    superAdminDob: '1990-01-01',
    isProduction: false,
  })
  const client = new Client(app)
  const logged = await client.send('POST', '/api/auth/login', { phone: number, password })
  assert.equal(logged.status, 200)
  assert.equal(logged.json.user?.role, 'admin')
  assert.equal(logged.json.user?.admin, true)
  assert.equal((await client.send('GET', '/api/admin/whoami')).status, 200)
})

test('login is rate limited per IP', async () => {
  const client = new Client(limited)
  const number = nextPhone()
  await client.csrf()
  const first = await client.send('POST', '/api/auth/login', { phone: number, password: 'wrong-password-9' })
  const second = await client.send('POST', '/api/auth/login', { phone: number, password: 'wrong-password-9' })
  const third = await client.send('POST', '/api/auth/login', { phone: number, password: 'wrong-password-9' })
  assert.equal(first.status, 401)
  assert.equal(second.status, 401)
  assert.equal(third.status, 429)
  assert.equal(third.json.error, 'rate_limited')
})
