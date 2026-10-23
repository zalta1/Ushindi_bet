import type { AppConfig } from './config.js'
import { getPool, withTx } from './db.js'
import { isAdult, normalizeName, normalizeTzPhone, passwordProblem } from './identity.js'
import { hashPassword } from './passwords.js'

function configuredPhone(cfg: AppConfig): string {
  return cfg.adminPhone || cfg.superAdminPhone
}

function configuredPassword(cfg: AppConfig): string {
  return cfg.adminPassword || cfg.superAdminPassword
}

async function promote(cfg: AppConfig, id: string, phone: string, from: string) {
  if (from === 'admin') return
  await getPool(cfg).query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [id])
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload)
     VALUES ($1, $2, 'admin.seed.promote', $3::jsonb)`,
    [id, phone, JSON.stringify({ from, to: 'admin' })],
  )
}

/** Create or promote the phone in ADMIN_PHONE (or SUPER_ADMIN_PHONE) to admin. */
export async function seedAdmin(cfg: AppConfig): Promise<void> {
  const rawPhone = configuredPhone(cfg)
  const phone = rawPhone ? normalizeTzPhone(rawPhone) : null
  if (rawPhone && !phone) throw new Error('ADMIN_PHONE (or SUPER_ADMIN_PHONE) is not a Tanzanian mobile number')
  if (!phone) return

  const existing = await getPool(cfg).query<{ id: string; role: string }>(
    `SELECT id, role FROM users WHERE phone = $1`,
    [phone],
  )
  const row = existing.rows[0]
  if (row) {
    await promote(cfg, row.id, phone, row.role)
    return
  }

  const password = configuredPassword(cfg)
  if (!password) {
    if (cfg.isProduction) {
      throw new Error('ADMIN_PASSWORD is required in production until the admin account exists')
    }
    console.warn('ADMIN_PHONE is set but ADMIN_PASSWORD is empty. That phone becomes admin when it registers.')
    return
  }

  const name = normalizeName(cfg.adminName || cfg.superAdminName)
  const dob = cfg.adminDob || cfg.superAdminDob
  if (!name) throw new Error('ADMIN_NAME is invalid')
  if (!isAdult(dob)) throw new Error('ADMIN_DOB must be 18+')
  const problem = passwordProblem(password, phone, !cfg.isProduction)
  if (problem) throw new Error('ADMIN_PASSWORD does not meet the password policy')

  const passwordHash = await hashPassword(password)
  const userId = await withTx(cfg, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (phone, password_hash, full_name, dob, role)
       VALUES ($1, $2, $3, $4, 'admin')
       ON CONFLICT (phone) DO NOTHING
       RETURNING id`,
      [phone, passwordHash, name, dob],
    )
    if (!inserted.rows[0]) return null
    await client.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [inserted.rows[0].id])
    return inserted.rows[0].id
  })
  if (!userId) {
    const again = await getPool(cfg).query<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE phone = $1`,
      [phone],
    )
    const raced = again.rows[0]
    if (raced) await promote(cfg, raced.id, phone, raced.role)
    return
  }
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload)
     VALUES ($1, $2, 'admin.seed.create', '{"role":"admin"}'::jsonb)`,
    [userId, phone],
  )
  console.info('admin account ensured')
}

export const seedSuperAdmin = seedAdmin
