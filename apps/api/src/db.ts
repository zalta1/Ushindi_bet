import pg from 'pg'
import type { AppConfig } from './config.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(cfg: AppConfig): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: cfg.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'ushindi-api',
      options: '-c TimeZone=Africa/Dar_es_Salaam -c statement_timeout=10000 -c lock_timeout=2000',
    })
    pool.on('error', (err) => {
      console.error('pg pool error', err.message)
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = null
}

export async function withTx<T>(cfg: AppConfig, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool(cfg).connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection may already be closed.
    }
    throw err
  } finally {
    client.release()
  }
}
