/**
 * Seven admin roles, plus `player` for customer accounts.
 * zalta1/betstapro was not readable from this environment (the GitHub API
 * returned 404), so these names are a sportsbook back-office split:
 * super_admin, admin, finance, risk, support, marketing, compliance.
 * super_admin is seeded from SUPER_ADMIN_PHONE and is the only role that
 * can assign roles. Every check below is enforced again on the server.
 */
export const ADMIN_ROLES = [
  'super_admin',
  'admin',
  'finance',
  'risk',
  'support',
  'marketing',
  'compliance',
] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]
export type AccountRole = AdminRole | 'player'

export const PERMISSIONS = {
  'config.read': ['super_admin', 'admin', 'risk'],
  'config.write': ['super_admin', 'admin'],
  'users.read': ['super_admin', 'admin', 'finance', 'risk', 'support', 'compliance'],
  'roles.write': ['super_admin'],
  'audit.read': ['super_admin', 'admin', 'finance', 'risk', 'compliance'],
  'kyc.read': ['super_admin', 'admin', 'support', 'compliance'],
  'auth_events.read': ['super_admin', 'compliance', 'risk'],
} as const

export type Permission = keyof typeof PERMISSIONS

const adminSet = new Set<string>(ADMIN_ROLES)

export function isAdminRole(role: string): role is AdminRole {
  return adminSet.has(role)
}

export function isAccountRole(role: string): role is AccountRole {
  return role === 'player' || isAdminRole(role)
}

export function hasPermission(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role)
}

export function permissionsFor(role: string): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => hasPermission(role, permission))
}
