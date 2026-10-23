/** Keep these checks aligned with apps/api/src/identity.ts. */
export const PASSWORD_MIN = 12

export type PasswordIssue = 'min_length' | 'max_length' | 'letter_and_digit' | 'contains_phone' | 'common'

const PLACEHOLDERS = new Set(['local_dev_only_change_me_1', 'password123', 'changeme1234'])

export function normalizeTzPhone(input: string): string | null {
  let rest = input.trim().replace(/[\s()-]/g, '')
  if (rest.startsWith('+')) rest = rest.slice(1)
  if (rest.startsWith('255')) rest = rest.slice(3)
  else if (rest.startsWith('0')) rest = rest.slice(1)
  if (!/^[67]\d{8}$/.test(rest)) return null
  return `+255${rest}`
}

export function passwordIssue(password: string, phone: string): PasswordIssue | null {
  if (password.length < PASSWORD_MIN) return 'min_length'
  if (password.length > 128) return 'max_length'
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'letter_and_digit'
  if (PLACEHOLDERS.has(password)) return 'common'
  const digits = phone.replace(/\D/g, '')
  const national = digits.replace(/^255/, '')
  if ((digits.length >= 9 && password.includes(digits)) || (national.length >= 9 && password.includes(national))) {
    return 'contains_phone'
  }
  return null
}

export const passwordIssueKey: Record<PasswordIssue, string> = {
  min_length: 'errPasswordMin',
  max_length: 'errPasswordLong',
  letter_and_digit: 'errPasswordMix',
  contains_phone: 'errPasswordPhone',
  common: 'errPasswordCommon',
}
