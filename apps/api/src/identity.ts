const PHONE = /^\+255[67]\d{8}$/

/** Normalize a Tanzanian mobile number to E.164 (+2557XXXXXXXX or +2556XXXXXXXX). */
export function normalizeTzPhone(input: string): string | null {
  if (typeof input !== 'string') return null
  let rest = input.trim().replace(/[\s()-]/g, '')
  if (rest.startsWith('+')) rest = rest.slice(1)
  if (rest.startsWith('255')) rest = rest.slice(3)
  else if (rest.startsWith('0')) rest = rest.slice(1)
  if (!/^[67]\d{8}$/.test(rest)) return null
  const phone = `+255${rest}`
  return PHONE.test(phone) ? phone : null
}

export function normalizeName(input: string): string | null {
  if (typeof input !== 'string') return null
  const name = input.trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 80) return null
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(name)) return null
  return name
}

/** 18+ as of the current calendar date in Africa/Dar_es_Salaam. */
export function isAdult(dob: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false
  const [y, m, d] = dob.split('-').map(Number)
  if (!y || !m || !d) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return false
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [ty, tm, td] = today.split('-').map(Number)
  let age = ty - y
  if (tm < m || (tm === m && td < d)) age -= 1
  return age >= 18
}

const PLACEHOLDER_PASSWORDS = new Set([
  'local_dev_only_change_me_1',
  'password123',
  'changeme1234',
])

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

export type PasswordIssue = 'min_length' | 'max_length' | 'letter_and_digit' | 'contains_phone' | 'common'

export function passwordProblem(password: string, phone: string, allowPlaceholder = false): PasswordIssue | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return 'min_length'
  if (password.length > PASSWORD_MAX) return 'max_length'
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'letter_and_digit'
  if (!allowPlaceholder && PLACEHOLDER_PASSWORDS.has(password)) return 'common'
  const digits = phone.replace(/\D/g, '')
  const national = digits.replace(/^255/, '')
  if ((digits.length >= 9 && password.includes(digits)) || (national.length >= 9 && password.includes(national))) {
    return 'contains_phone'
  }
  return null
}
