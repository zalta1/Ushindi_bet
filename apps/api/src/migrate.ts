import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from './config.js'
import { getPool } from './db.js'

const LOCK_KEY = 842164201

export function resolveMigrationsDir(cfg: AppConfig): string {
  if (cfg.migrationsDir) return cfg.migrationsDir
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(process.cwd(), 'db/migrations'),
    path.resolve(process.cwd(), '../../db/migrations'),
    path.resolve(here, '../../../db/migrations'),
    path.resolve(here, '../../../../db/migrations'),
  ]
  const found = candidates.find((dir) => existsSync(dir))
  if (!found) throw new Error(`Migrations directory not found. Tried: ${candidates.join(', ')}`)
  return found
}

export async function migrate(cfg: AppConfig): Promise<void> {
  const dir = cfg.migrationsDir || resolveMigrationsDir(cfg)
  const client = await getPool(cfg).connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations')
    const done = new Set(applied.rows.map((row) => row.version))
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined)
    client.release()
  }
}
