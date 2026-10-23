import type { FastifyInstance } from 'fastify'

export function phone(n: number): string {
  return `+2557${String(10_000_000 + n).slice(-8)}`
}

export class Client {
  jar: Record<string, string> = {}
  constructor(private app: FastifyInstance) {}

  take(headers: { 'set-cookie'?: string | string[] | number }) {
    const raw = headers['set-cookie']
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)]
    for (const item of list) {
      const pair = item.split(';')[0]
      const idx = pair.indexOf('=')
      if (idx <= 0) continue
      const name = pair.slice(0, idx)
      const value = pair.slice(idx + 1)
      if (!value) delete this.jar[name]
      else this.jar[name] = value
    }
  }

  header() {
    return Object.entries(this.jar).map(([key, value]) => `${key}=${value}`).join('; ')
  }

  async csrf() {
    const res = await this.app.inject({ method: 'GET', url: '/api/auth/csrf' })
    this.take(res.headers)
    return res
  }

  async send(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
    if (method !== 'GET' && !this.jar.ushindi_csrf) await this.csrf()
    const res = await this.app.inject({
      method,
      url,
      headers: {
        cookie: this.header(),
        ...(method === 'GET' ? {} : { 'x-csrf-token': this.jar.ushindi_csrf ?? '' }),
      },
      payload: body,
    })
    this.take(res.headers)
    let json: Record<string, any> = {}
    if (res.body) {
      try { json = JSON.parse(res.body) } catch { json = {} }
    }
    return { status: res.statusCode, json, headers: res.headers }
  }
}
