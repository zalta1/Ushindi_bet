export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code)
  }
}

export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(n)) throw new ApiError(500, 'unsafe_amount')
  return n
}
