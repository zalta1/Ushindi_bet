export class ApiClientError extends Error {
  status: number
  code: string
  fields: Record<string, string>
  minutes: number | null
  minDeposit: number | null
  maxDeposit: number | null
  constructor(
    status: number,
    code: string,
    fields: Record<string, string> = {},
    minutes: number | null = null,
    minDeposit: number | null = null,
    maxDeposit: number | null = null,
  ) {
    super(code)
    this.status = status
    this.code = code
    this.fields = fields
    this.minutes = minutes
    this.minDeposit = minDeposit
    this.maxDeposit = maxDeposit
  }
}

const noRefresh = new Set(['/api/auth/csrf', '/api/auth/login', '/api/auth/register', '/api/auth/refresh'])

export function csrfFromCookie(): string {
  const match = document.cookie.match(/(?:^|; )ushindi_csrf=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

type ApiOptions = {
  method?: string
  json?: unknown
  headers?: HeadersInit
  retried?: boolean
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers = new Headers(opts.headers)
  headers.set('accept', 'application/json')
  if (opts.json !== undefined) headers.set('content-type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = csrfFromCookie()
    if (csrf) headers.set('x-csrf-token', csrf)
  }
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    cache: 'no-store',
  })
  if (res.status === 401 && !opts.retried && !noRefresh.has(path)) {
    const csrf = csrfFromCookie()
    const again = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    })
    if (again.ok) return api<T>(path, { ...opts, retried: true })
  }
  const data = await res.json().catch(() => ({})) as {
    error?: string
    fields?: Record<string, string>
    minutes?: number
    minDeposit?: number
    maxDeposit?: number
  }
  if (!res.ok) {
    throw new ApiClientError(
      res.status,
      data.error || 'request_failed',
      data.fields && typeof data.fields === 'object' ? data.fields : {},
      typeof data.minutes === 'number' ? data.minutes : null,
      typeof data.minDeposit === 'number' ? data.minDeposit : null,
      typeof data.maxDeposit === 'number' ? data.maxDeposit : null,
    )
  }
  return data as T
}

export async function ensureCsrf() {
  if (!csrfFromCookie()) await api('/api/auth/csrf')
}
