export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code)
  }
}

const PASSWORD_ISSUES = new Set(['min_length', 'max_length', 'letter_and_digit', 'contains_phone', 'common'])

/** One field keeps its own code. A password issue is still `weak_password`, with the reason in `fields`. */
export function fieldError(fields: Record<string, string>): ApiError {
  const values = Object.values(fields)
  const only = values.length === 1 ? values[0] : ''
  const code = values.length !== 1 ? 'validation' : PASSWORD_ISSUES.has(only) ? 'weak_password' : only
  return new ApiError(400, code, { fields })
}

export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(n)) throw new ApiError(500, 'unsafe_amount')
  return n
}
