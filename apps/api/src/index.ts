import './env-bootstrap.js'
import { purgeExpiredSessions } from './auth/sessions.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { closePool, waitForDatabase } from './db.js'
import { migrate } from './migrate.js'
import { loadPersistedSettings } from './admin/settings-store.js'
import { seedAdmin } from './seed.js'

const cfg = loadConfig()
await waitForDatabase(cfg)
await migrate(cfg)
await loadPersistedSettings(cfg)
await seedAdmin(cfg)
await purgeExpiredSessions(cfg)
const app = await buildApp()

const shutdown = async () => {
  await app.close()
  await closePool()
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })

await app.listen({ port: cfg.port, host: '0.0.0.0' })
