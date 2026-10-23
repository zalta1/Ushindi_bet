/**
 * Two account roles. `admin` sees every admin section. `player` does not.
 * The older split (super_admin, finance, risk, support, marketing,
 * compliance) was removed. Migration 005 turns those rows into admin.
 * Every check here is enforced again on the server. Writes are audited.
 */
export const ADMIN_ROLES = ['admin'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]
export type AccountRole = AdminRole | 'player'

export const PERMISSIONS = {
  'config.read': ['admin'],
  'config.write': ['admin'],
  'users.read': ['admin'],
  'roles.write': ['admin'],
  'audit.read': ['admin'],
  'kyc.read': ['admin'],
  'auth_events.read': ['admin'],
} as const

export type Permission = keyof typeof PERMISSIONS

export function isAdminRole(role: string): role is AdminRole {
  return role === 'admin'
}

export function isAccountRole(role: string): role is AccountRole {
  return role === 'player' || role === 'admin'
}

export function hasPermission(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role)
}

export function permissionsFor(role: string): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => hasPermission(role, permission))
}
