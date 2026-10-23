export const PLACEHOLDER_ADMIN_PASSWORD = 'local_dev_only_change_me_1'

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw === 'true'
}

function envValue(...names: string[]): string {
  for (const name of names) {
    const raw = process.env[name]
    if (raw !== undefined && raw !== '') return raw
  }
  return ''
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
  return n
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'
  const isTest = nodeEnv === 'test'
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (corsOrigins.length === 0) throw new Error('CORS_ORIGIN must list at least one origin')

  // ADMIN_* is the name to use. SUPER_ADMIN_* still works when the new name is empty.
  const adminPhone = envValue('ADMIN_PHONE', 'SUPER_ADMIN_PHONE')
  const adminPassword = envValue('ADMIN_PASSWORD', 'SUPER_ADMIN_PASSWORD')
  const adminName = envValue('ADMIN_NAME', 'SUPER_ADMIN_NAME') || 'Ushindi Admin'
  const adminDob = envValue('ADMIN_DOB', 'SUPER_ADMIN_DOB') || '1990-01-01'
  const cookieSecure = bool('COOKIE_SECURE', isProduction)
  if ((isProduction || cookieSecure) && adminPassword === PLACEHOLDER_ADMIN_PASSWORD) {
    throw new Error('Refusing the example ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD outside local development')
  }
  if (isProduction && !adminPhone) {
    throw new Error('ADMIN_PHONE is required in production (SUPER_ADMIN_PHONE is still accepted)')
  }
  if (isProduction && !process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required in production')
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    databaseUrl,
    redisUrl: process.env.REDIS_URL ?? '',
    port: int('PORT', 4000),
    corsOrigins,
    cookieSecure,
    trustProxy: bool('TRUST_PROXY', false),
    accessTtlSeconds: int('ACCESS_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: int('REFRESH_TTL_SECONDS', 7 * 24 * 60 * 60),
    lockoutThreshold: int('LOGIN_LOCKOUT_THRESHOLD', 5),
    lockoutSeconds: int('LOGIN_LOCKOUT_SECONDS', 15 * 60),
    adminPhone,
    adminPassword,
    adminName,
    adminDob,
    superAdminPhone: adminPhone,
    superAdminPassword: adminPassword,
    superAdminName: adminName,
    superAdminDob: adminDob,
    authRateMax: int('AUTH_RATE_LIMIT_MAX', 10),
    registerRateMax: int('REGISTER_RATE_LIMIT_MAX', 5),
    migrationsDir: process.env.MIGRATIONS_DIR ?? '',
  }
}

export type AppConfig = ReturnType<typeof loadConfig>
