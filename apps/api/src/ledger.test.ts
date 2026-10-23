import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
process.env.COOKIE_SECURE = 'false'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test'
process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
delete process.env.SUPER_ADMIN_PHONE
delete process.env.SUPER_ADMIN_PASSWORD
delete process.env.ADMIN_PHONE
delete process.env.ADMIN_PASSWORD
delete process.env.REDIS_URL

const dbName = new URL(process.env.DATABASE_URL).pathname
if (!dbName.includes('test')) throw new Error(`Refusing to run ledger tests against ${dbName}`)

const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let n = 400

function nextPhone() {
  n += 1
  return phone(n)
}

async function makeUser() {
  const number = nextPhone()
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (phone, password_hash, full_name, dob)
     VALUES ($1, 'not-a-login', 'Ledger User', '1990-01-01')
     RETURNING id`,
    [number],
  )
  await pool.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [user.rows[0].id])
  return user.rows[0].id
}

async function credit(userId: string, amount: number, key: string, bucket = 'cash') {
  const { rows } = await pool.query<{ result: { idempotent: boolean; balance_tzs: number; bonus_balance_tzs: number } }>(
    `SELECT wallet_credit($1, $2, 'deposit', $3, $4, NULL, NULL, NULL, NULL) AS result`,
    [userId, amount, key, bucket],
  )
  return rows[0].result
}

async function debit(userId: string, amount: number, key: string) {
  const { rows } = await pool.query<{ result: { balance_tzs: number } }>(
    `SELECT wallet_debit($1, $2, 'withdraw', $3, 'cash', NULL, NULL, NULL, NULL) AS result`,
    [userId, amount, key],
  )
  return rows[0].result
}

before(async () => {
  await migrate(cfg)
})

beforeEach(async () => {
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, wallets, users RESTART IDENTITY CASCADE`)
})

after(async () => {
  await closePool()
})

test('wallet_credit and wallet_debit are atomic, idempotent, and cannot overdraw', async () => {
  const userId = await makeUser()
  const first = await credit(userId, 10_000, 'credit-key-0001')
  const replay = await credit(userId, 10_000, 'credit-key-0001')
  assert.equal(Number(first.balance_tzs), 10_000)
  assert.equal(replay.idempotent, true)
  const bonus = await credit(userId, 2_000, 'bonus-key-00001', 'bonus')
  assert.equal(Number(bonus.bonus_balance_tzs), 2_000)
  assert.equal(Number(bonus.balance_tzs), 10_000)

  const withdrawn = await debit(userId, 3_000, 'debit-key-00001')
  assert.equal(Number(withdrawn.balance_tzs), 7_000)
  await assert.rejects(
    () => debit(userId, 8_000, 'debit-key-00002'),
    /insufficient_funds/,
  )
  const balance = await pool.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  assert.equal(Number(balance.rows[0].balance_tzs), 7_000)

  await assert.rejects(
    () => credit(userId, 1, 'credit-key-0001'),
    /idempotency_conflict/,
  )
})

test('two debits cannot spend the same shillings', async () => {
  const userId = await makeUser()
  await credit(userId, 5_000, 'race-credit-0001')
  const results = await Promise.allSettled([
    debit(userId, 5_000, 'race-debit-00001'),
    debit(userId, 5_000, 'race-debit-00002'),
  ])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
  const balance = await pool.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  assert.equal(Number(balance.rows[0].balance_tzs), 0)
  const rows = await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND direction = 'debit'`, [userId])
  assert.equal(rows.rows[0].n, 1)
})

test('place_bet_atomic debits the stake and prices the payout from the legs', async () => {
  const userId = await makeUser()
  await credit(userId, 10_000, 'bet-credit-00001')
  const legs = [
    { match_id: 1, market: '1X2', selection: '1', odds: 2 },
    { market: 'BTTS', selection: 'Yes', odds: 1.5 },
  ]
  const placed = await pool.query<{ result: { idempotent: boolean; potential_payout_tzs: number; balance_tzs: number; bet_id: string } }>(
    `SELECT place_bet_atomic($1, $2, $3::jsonb, $4) AS result`,
    [userId, 1000, JSON.stringify(legs), 'bet-key-0000001'],
  )
  assert.equal(Number(placed.rows[0].result.potential_payout_tzs), 3000)
  assert.equal(Number(placed.rows[0].result.balance_tzs), 9000)
  const replay = await pool.query<{ result: { idempotent: boolean; bet_id: string; balance_tzs: number } }>(
    `SELECT place_bet_atomic($1, $2, $3::jsonb, $4) AS result`,
    [userId, 1000, JSON.stringify(legs), 'bet-key-0000001'],
  )
  assert.equal(replay.rows[0].result.idempotent, true)
  assert.equal(replay.rows[0].result.bet_id, placed.rows[0].result.bet_id)
  const balance = await pool.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  assert.equal(Number(balance.rows[0].balance_tzs), 9000)
  const legsRows = await pool.query(`SELECT count(*)::int AS n FROM bet_legs WHERE bet_id = $1`, [placed.rows[0].result.bet_id])
  assert.equal(legsRows.rows[0].n, 2)

  await assert.rejects(
    () => pool.query(`SELECT place_bet_atomic($1, $2, $3::jsonb, $4)`, [userId, 100_000, JSON.stringify(legs), 'bet-key-0000002']),
    /insufficient_funds/,
  )
})

test('ledger and audit rows cannot be updated or deleted', async () => {
  const userId = await makeUser()
  await credit(userId, 1000, 'append-credit-001')
  await pool.query(
    `INSERT INTO audit_log (actor, action, payload) VALUES ('test', 'test.event', '{}'::jsonb)`,
  )
  await assert.rejects(() => pool.query(`UPDATE ledger_entries SET amount_tzs = 1`), /append-only/)
  await assert.rejects(() => pool.query(`DELETE FROM ledger_entries`), /append-only/)
  await assert.rejects(() => pool.query(`DELETE FROM audit_log`), /append-only/)
})
