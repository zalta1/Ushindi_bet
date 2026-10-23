import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import {
  BOOL_SETTING_KEYS,
  INT_SETTING_KEYS,
  operatorConfig,
  type BoolSettingKey,
  type IntSettingKey,
} from '../operator-config.js'

async function writeAll(cfg: AppConfig, actorId: string | null) {
  const client = await getPool(cfg).connect()
  try {
    await client.query('BEGIN')
    for (const key of INT_SETTING_KEYS) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(operatorConfig[key]), actorId],
      )
    }
    for (const key of BOOL_SETTING_KEYS) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(operatorConfig[key]), actorId],
      )
    }
    await client.query(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('agentWhatsapp', $1::jsonb, now(), $2)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(operatorConfig.agentWhatsapp), actorId],
    )
    await client.query(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('currency', '"TZS"'::jsonb, now(), $1)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [actorId],
    )
    await client.query('COMMIT')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already closed */ }
    throw err
  } finally {
    client.release()
  }
}

function applyRow(key: string, value: unknown) {
  if ((INT_SETTING_KEYS as readonly string[]).includes(key)) {
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isInteger(n) && n >= 0 && n <= 100_000_000) {
      operatorConfig[key as IntSettingKey] = n
    }
    return
  }
  if ((BOOL_SETTING_KEYS as readonly string[]).includes(key) && typeof value === 'boolean') {
    operatorConfig[key as BoolSettingKey] = value
  }
  if (key === 'agentWhatsapp' && typeof value === 'string' && value.length <= 20) {
    operatorConfig.agentWhatsapp = value
  }
}

/** Load the settings table over the in-memory defaults. An empty table stores the env defaults. */
export async function loadPersistedSettings(cfg: AppConfig): Promise<void> {
  const { rows } = await getPool(cfg).query<{ key: string; value: unknown }>('SELECT key, value FROM settings')
  if (rows.length === 0) {
    await writeAll(cfg, null)
    return
  }
  for (const row of rows) applyRow(row.key, row.value)
  if (operatorConfig.minDeposit > operatorConfig.maxDeposit) {
    throw new Error('Stored minDeposit is above maxDeposit')
  }
  if (operatorConfig.minStake > operatorConfig.maxStake || operatorConfig.minWithdraw > operatorConfig.maxWithdraw) {
    throw new Error('Stored stake or withdrawal limits are inverted')
  }
  if (operatorConfig.minDeposit < 1) throw new Error('Stored minDeposit must be at least 1')
}

export async function saveOperatorSettings(cfg: AppConfig, actorId: string | null): Promise<void> {
  await writeAll(cfg, actorId)
}
