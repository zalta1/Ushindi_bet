import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import '@fastify/cookie'
import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { ApiError, money } from '../errors.js'
import { permissionsFor, type AccountRole } from '../admin/roles.js'

export const ACCESS_COOKIE = 'ushindi_sid'
export const REFRESH_COOKIE = 'ushindi_refresh'
export const CSRF_COOKIE = 'ushindi_csrf'
export const HOLD_ACCESS = 'ushindi_hold_sid'
export const HOLD_REFRESH = 'ushindi_hold_refresh'
export const HOLD_CSRF = 'ushindi_hold_csrf'

export type AuthContext = {
  sessionId: string
  familyId: string
  userId: string
  role: AccountRole
  csrfHash: string
  phone: string
  fullName: string
  kycStatus: string
  balanceTzs: number
  bonusBalanceTzs: number
  readOnly: boolean
  impersonatorUserId: string | null
  impersonationId: string | null
  mustChangePassword: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

function cookieBase(cfg: AppConfig, httpOnly: boolean, maxAge: number, pathName: string) {
  return {
    httpOnly,
    secure: cfg.cookieSecure,
    sameSite: 'lax' as const,
    path: pathName,
    maxAge,
  }
}

export function readCookie(req: FastifyRequest, name: string): string {
  const value = req.cookies?.[name]
  return typeof value === 'string' ? value : ''
}

export function setSessionCookies(
  reply: FastifyReply,
  cfg: AppConfig,
  access: string,
  refresh: string,
  csrf: string,
) {
  reply.setCookie(ACCESS_COOKIE, access, cookieBase(cfg, true, cfg.accessTtlSeconds, '/'))
  reply.setCookie(REFRESH_COOKIE, refresh, cookieBase(cfg, true, cfg.refreshTtlSeconds, '/api/auth'))
  reply.setCookie(CSRF_COOKIE, csrf, cookieBase(cfg, false, cfg.refreshTtlSeconds, '/'))
}

export function clearSessionCookies(reply: FastifyReply, cfg: AppConfig) {
  const access = cookieBase(cfg, true, 0, '/')
  const refresh = cookieBase(cfg, true, 0, '/api/auth')
  const csrf = cookieBase(cfg, false, 0, '/')
  reply.clearCookie(ACCESS_COOKIE, access)
  reply.clearCookie(REFRESH_COOKIE, refresh)
  reply.clearCookie(CSRF_COOKIE, csrf)
}

export function assertOrigin(req: FastifyRequest, origins: string[]) {
  const origin = req.headers.origin
  if (!origin) return
  if (!origins.includes(origin)) throw new ApiError(403, 'origin_not_allowed')
}

export function assertCsrf(req: FastifyRequest, csrfHash?: string) {
  const header = String(req.headers['x-csrf-token'] ?? '')
  const cookie = readCookie(req, CSRF_COOKIE)
  if (!header || !cookie || !tokensEqual(header, cookie)) throw new ApiError(403, 'csrf_invalid')
  if (csrfHash && !tokensEqual(sha256(header), csrfHash)) throw new ApiError(403, 'csrf_invalid')
}

type SessionRow = {
  id: string
  family_id: string
  user_id: string
  role: AccountRole
  csrf_hash: string
  phone: string
  full_name: string | null
  kyc_status: string
  balance_tzs: string | null
  bonus_balance_tzs: string | null
  revoked_at: Date | null
  refresh_expires_at: Date
  read_only: boolean
  impersonator_user_id: string | null
  impersonation_id: string | null
  must_change_password: boolean
}

const sessionSelect = `
  SELECT s.id, s.family_id, s.user_id, s.csrf_hash, s.revoked_at, s.refresh_expires_at,
         s.read_only, s.impersonator_user_id, s.impersonation_id,
         u.role, u.phone, u.full_name, u.kyc_status, u.must_change_password,
         w.balance_tzs, w.bonus_balance_tzs
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN wallets w ON w.user_id = u.id
`

function toAuth(row: SessionRow): AuthContext {
  return {
    sessionId: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    role: row.role,
    csrfHash: row.csrf_hash,
    phone: row.phone,
    fullName: row.full_name ?? '',
    kycStatus: row.kyc_status,
    balanceTzs: money(row.balance_tzs),
    bonusBalanceTzs: money(row.bonus_balance_tzs),
    readOnly: row.read_only,
    impersonatorUserId: row.impersonator_user_id,
    impersonationId: row.impersonation_id,
    mustChangePassword: row.must_change_password,
  }
}

export function publicUser(auth: AuthContext) {
  return {
    id: auth.userId,
    phone: auth.phone,
    fullName: auth.fullName,
    role: auth.role,
    kycStatus: auth.kycStatus,
    balanceTzs: auth.balanceTzs,
    bonusBalanceTzs: auth.bonusBalanceTzs,
    admin: auth.role === 'admin' && !auth.readOnly,
    permissions: auth.readOnly ? [] : permissionsFor(auth.role),
    readOnly: auth.readOnly,
    impersonatorUserId: auth.impersonatorUserId,
    mustChangePassword: auth.mustChangePassword,
  }
}

export async function readAccessSession(cfg: AppConfig, req: FastifyRequest): Promise<AuthContext | null> {
  const token = readCookie(req, ACCESS_COOKIE)
  if (!token) return null
  const { rows } = await getPool(cfg).query<SessionRow>(
    `${sessionSelect}
      WHERE s.access_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.closed_at IS NULL`,
    [sha256(token)],
  )
  return rows[0] ? toAuth(rows[0]) : null
}

export async function issueSession(
  cfg: AppConfig,
  reply: FastifyReply,
  userId: string,
  req: FastifyRequest,
  familyId = randomUUID(),
): Promise<AuthContext> {
  const access = newToken()
  const refresh = newToken()
  const csrf = newToken()
  const id = randomUUID()
  await getPool(cfg).query(
    `INSERT INTO sessions (
       id, user_id, family_id, access_hash, refresh_hash, csrf_hash,
       expires_at, refresh_expires_at, ip, user_agent
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       now() + ($7 || ' seconds')::interval,
       now() + ($8 || ' seconds')::interval,
       $9, $10
     )`,
    [
      id,
      userId,
      familyId,
      sha256(access),
      sha256(refresh),
      sha256(csrf),
      String(cfg.accessTtlSeconds),
      String(cfg.refreshTtlSeconds),
      req.ip?.slice(0, 64) ?? null,
      String(req.headers['user-agent'] ?? '').slice(0, 200),
    ],
  )
  setSessionCookies(reply, cfg, access, refresh, csrf)
  const { rows } = await getPool(cfg).query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [id])
  return toAuth(rows[0])
}

export async function rotateSession(cfg: AppConfig, req: FastifyRequest, reply: FastifyReply): Promise<AuthContext> {
  const token = readCookie(req, REFRESH_COOKIE)
  if (!token) throw new ApiError(401, 'unauthenticated')
  const client = await getPool(cfg).connect()
  let closed = false
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<SessionRow>(
      `${sessionSelect} WHERE s.refresh_hash = $1 AND u.closed_at IS NULL FOR UPDATE OF s`,
      [sha256(token)],
    )
    const row = rows[0]
    if (!row) throw new ApiError(401, 'unauthenticated')
    // A revoked refresh token means an old token was replayed. Burn the family
    // even when the CSRF header is missing so a stolen cookie cannot stay warm.
    if (row.revoked_at) {
      await client.query(
        `UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      )
      await client.query('COMMIT')
      closed = true
      clearSessionCookies(reply, cfg)
      throw new ApiError(401, 'session_reused')
    }
    if (new Date(row.refresh_expires_at).getTime() <= Date.now()) {
      await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.id])
      await client.query('COMMIT')
      closed = true
      clearSessionCookies(reply, cfg)
      throw new ApiError(401, 'unauthenticated')
    }
    const header = String(req.headers['x-csrf-token'] ?? '')
    const cookie = readCookie(req, CSRF_COOKIE)
    if (!header || !cookie || !tokensEqual(header, cookie) || !tokensEqual(sha256(header), row.csrf_hash)) {
      throw new ApiError(403, 'csrf_invalid')
    }
    const access = newToken()
    const refresh = newToken()
    const csrf = newToken()
    const id = randomUUID()
    await client.query(
      `INSERT INTO sessions (
         id, user_id, family_id, access_hash, refresh_hash, csrf_hash,
         expires_at, refresh_expires_at, ip, user_agent,
         read_only, impersonator_user_id, impersonation_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         now() + ($7 || ' seconds')::interval,
         $8, $9, $10,
         $11, $12, $13
       )`,
      [
        id,
        row.user_id,
        row.family_id,
        sha256(access),
        sha256(refresh),
        sha256(csrf),
        String(cfg.accessTtlSeconds),
        row.refresh_expires_at,
        req.ip?.slice(0, 64) ?? null,
        String(req.headers['user-agent'] ?? '').slice(0, 200),
        row.read_only,
        row.impersonator_user_id,
        row.impersonation_id,
      ],
    )
    await client.query(
      `UPDATE sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
      [row.id, id],
    )
    await client.query('COMMIT')
    closed = true
    setSessionCookies(reply, cfg, access, refresh, csrf)
    const loaded = await getPool(cfg).query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [id])
    return toAuth(loaded.rows[0])
  } catch (err) {
    if (!closed) {
      try { await client.query('ROLLBACK') } catch { /* already finished */ }
    }
    throw err
  } finally {
    client.release()
  }
}

export async function revokeFamily(cfg: AppConfig, familyId: string): Promise<void> {
  await getPool(cfg).query(
    `UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  )
}

export async function revokeAllSessions(cfg: AppConfig, userId: string): Promise<void> {
  await getPool(cfg).query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  )
}

export async function purgeExpiredSessions(cfg: AppConfig): Promise<void> {
  await getPool(cfg).query(`DELETE FROM sessions WHERE refresh_expires_at < now() - interval '1 day'`)
}

function setHoldCookies(reply: FastifyReply, cfg: AppConfig, access: string, refresh: string, csrf: string) {
  reply.setCookie(HOLD_ACCESS, access, cookieBase(cfg, true, cfg.refreshTtlSeconds, '/'))
  reply.setCookie(HOLD_REFRESH, refresh, cookieBase(cfg, true, cfg.refreshTtlSeconds, '/api/auth'))
  reply.setCookie(HOLD_CSRF, csrf, cookieBase(cfg, true, cfg.refreshTtlSeconds, '/'))
}

function clearHoldCookies(reply: FastifyReply, cfg: AppConfig) {
  reply.clearCookie(HOLD_ACCESS, cookieBase(cfg, true, 0, '/'))
  reply.clearCookie(HOLD_REFRESH, cookieBase(cfg, true, 0, '/api/auth'))
  reply.clearCookie(HOLD_CSRF, cookieBase(cfg, true, 0, '/'))
}

/** Swap the browser onto a short-lived read-only session for `targetUserId`. The admin cookies are held. */
export async function beginImpersonation(
  cfg: AppConfig,
  reply: FastifyReply,
  req: FastifyRequest,
  targetUserId: string,
  impersonationId: string,
): Promise<AuthContext> {
  if (!req.auth || req.auth.readOnly) throw new ApiError(409, 'already_impersonating')
  const heldAccess = readCookie(req, ACCESS_COOKIE)
  const heldRefresh = readCookie(req, REFRESH_COOKIE)
  const heldCsrf = readCookie(req, CSRF_COOKIE)
  if (!heldAccess || !heldRefresh || !heldCsrf) throw new ApiError(401, 'unauthenticated')

  const access = newToken()
  const refresh = newToken()
  const csrf = newToken()
  const id = randomUUID()
  await getPool(cfg).query(
    `INSERT INTO sessions (
       id, user_id, family_id, access_hash, refresh_hash, csrf_hash,
       expires_at, refresh_expires_at, ip, user_agent,
       read_only, impersonator_user_id, impersonation_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       now() + ($7 || ' seconds')::interval,
       now() + interval '15 minutes',
       $8, $9,
       true, $10, $11
     )`,
    [
      id,
      targetUserId,
      randomUUID(),
      sha256(access),
      sha256(refresh),
      sha256(csrf),
      String(Math.min(cfg.accessTtlSeconds, 15 * 60)),
      req.ip?.slice(0, 64) ?? null,
      String(req.headers['user-agent'] ?? '').slice(0, 200),
      req.auth.userId,
      impersonationId,
    ],
  )
  setHoldCookies(reply, cfg, heldAccess, heldRefresh, heldCsrf)
  setSessionCookies(reply, cfg, access, refresh, csrf)
  const { rows } = await getPool(cfg).query<SessionRow>(`${sessionSelect} WHERE s.id = $1`, [id])
  return toAuth(rows[0])
}

/** End a read-only impersonation session and put the admin cookies back. */
export async function stopImpersonation(cfg: AppConfig, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth?.readOnly) throw new ApiError(409, 'not_impersonating')
  const access = readCookie(req, HOLD_ACCESS)
  const refresh = readCookie(req, HOLD_REFRESH)
  const csrf = readCookie(req, HOLD_CSRF)
  await revokeFamily(cfg, req.auth.familyId)
  if (req.auth.impersonationId) {
    await getPool(cfg).query(
      `UPDATE impersonation_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`,
      [req.auth.impersonationId],
    )
  }
  clearHoldCookies(reply, cfg)
  if (!access || !refresh || !csrf) {
    clearSessionCookies(reply, cfg)
    throw new ApiError(401, 'unauthenticated')
  }
  setSessionCookies(reply, cfg, access, refresh, csrf)
}
