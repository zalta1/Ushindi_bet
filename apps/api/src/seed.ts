import type { AppConfig } from './config.js'
import { getPool, withTx } from './db.js'
import { isAdult, normalizeName, normalizeTzPhone, passwordProblem } from './identity.js'
import { hashPassword } from './passwords.js'

export async function seedSuperAdmin(cfg: AppConfig): Promise<void> {
  const phone = cfg.superAdminPhone ? normalizeTzPhone(cfg.superAdminPhone) : null
  if (cfg.superAdminPhone && !phone) throw new Error('SUPER_ADMIN_PHONE is not a Tanzanian mobile number')
  if (!phone) return

  const existing = await getPool(cfg).query<{ id: string; role: string }>(
    `SELECT id, role FROM users WHERE phone = $1`,
    [phone],
  )
  const row = existing.rows[0]
  if (row) {
    if (row.role !== 'super_admin') {
      await getPool(cfg).query(`UPDATE users SET role = 'super_admin', updated_at = now() WHERE id = $1`, [row.id])
      await getPool(cfg).query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.seed.promote', $3::jsonb)`,
        [row.id, phone, JSON.stringify({ from: row.role, to: 'super_admin' })],
      )
    }
    return
  }

  if (!cfg.superAdminPassword) {
    if (cfg.isProduction) {
      throw new Error('SUPER_ADMIN_PASSWORD is required in production until the super admin account exists')
    }
    console.warn('SUPER_ADMIN_PHONE is set but SUPER_ADMIN_PASSWORD is empty. That phone becomes super_admin when it registers. Set a password before exposing the service.')
    return
  }

  const name = normalizeName(cfg.superAdminName)
  if (!name) throw new Error('SUPER_ADMIN_NAME is invalid')
  if (!isAdult(cfg.superAdminDob)) throw new Error('SUPER_ADMIN_DOB must be 18+')
  const problem = passwordProblem(cfg.superAdminPassword, phone, !cfg.isProduction)
  if (problem) throw new Error('SUPER_ADMIN_PASSWORD does not meet the password policy')

  const passwordHash = await hashPassword(cfg.superAdminPassword)
  const userId = await withTx(cfg, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (phone, password_hash, full_name, dob, role)
       VALUES ($1, $2, $3, $4, 'super_admin')
       ON CONFLICT (phone) DO NOTHING
       RETURNING id`,
      [phone, passwordHash, name, cfg.superAdminDob],
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
    if (raced && raced.role !== 'super_admin') {
      await getPool(cfg).query(`UPDATE users SET role = 'super_admin', updated_at = now() WHERE id = $1`, [raced.id])
      await getPool(cfg).query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.seed.promote', $3::jsonb)`,
        [raced.id, phone, JSON.stringify({ from: raced.role, to: 'super_admin' })],
      )
    }
    return
  }
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload)
     VALUES ($1, $2, 'admin.seed.create', '{"role":"super_admin"}'::jsonb)`,
    [userId, phone],
  )
  console.info('super admin account ensured')
}
