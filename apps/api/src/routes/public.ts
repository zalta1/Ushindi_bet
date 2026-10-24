import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isAdminRole } from '../admin/roles.js'
import { ApiError } from '../errors.js'
import { applyMargin, operatorConfig } from '../operator-config.js'

export interface PaymentProvider {
  name: string
  deposit(p: { phone: string; amount: number }): Promise<{ ref: string; status: string }>
  withdraw(p: { phone: string; amount: number }): Promise<{ ref: string; status: string }>
}

export class MockMobileMoneyProvider implements PaymentProvider {
  constructor(public name: string) {}
  async deposit(_p: { phone: string; amount: number }) {
    return { ref: `MOCK-${this.name}-${crypto.randomUUID().slice(0, 8)}`, status: 'completed_sandbox' }
  }
  async withdraw(p: { phone: string; amount: number }) {
    return this.deposit(p)
  }
}

export const providers: Record<string, PaymentProvider> = Object.fromEntries(
  ['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'HaloPesa'].map((name) => [name, new MockMobileMoneyProvider(name)]),
)

export interface OddsFeedAdapter {
  getMatches(): unknown[]
}

const now = Date.now()
export const matches = [1, 2, 3, 4, 5, 6].map((i) => ({
  id: i,
  sport: ['Football', 'Football', 'Basketball', 'Football', 'Tennis', 'Football'][i - 1],
  league: ['Ligi Kuu TZ', 'EPL (mock)', 'NBA (mock)', 'Serie A (mock)', 'ATP (mock)', 'La Liga (mock)'][i - 1],
  home: ['Simba SC', 'Arsenal', 'LA Lakers', 'Inter', 'Alcaraz', 'Real Madrid'][i - 1],
  away: ['Yanga SC', 'Chelsea', 'Boston', 'Napoli', 'Sinner', 'Barcelona'][i - 1],
  kickoff: new Date(now + i * 3600e3).toISOString(),
  live: i <= 2,
  minute: i <= 2 ? 34 + i * 10 : 0,
  homeScore: i <= 2 ? 1 : 0,
  awayScore: i <= 2 ? 0 : 0,
  markets: {
    main: [
      { sel: '1', price: applyMargin(2.1) },
      { sel: 'X', price: applyMargin(3.2) },
      { sel: '2', price: applyMargin(2.8) },
    ],
    goals: [
      { sel: 'Over 2.5', price: applyMargin(1.9) },
      { sel: 'Under 2.5', price: applyMargin(1.85) },
    ],
    btts: [
      { sel: 'Yes', price: applyMargin(1.8) },
      { sel: 'No', price: applyMargin(1.95) },
    ],
  },
}))

export class MockLicensedFeedAdapter implements OddsFeedAdapter {
  getMatches() {
    return matches
  }
}

const audit: unknown[] = [{ actor: 'system', action: 'boot', at: new Date().toISOString() }]

let nonce = 0
let serverSeed = crypto.randomBytes(32).toString('hex')
let currentHash = crypto.createHash('sha256').update(serverSeed).digest('hex')

function crashPoint(seed: string, client: string, n: number) {
  const h = crypto.createHmac('sha256', seed).update(`${client}:${n}`).digest('hex')
  const r = parseInt(h.slice(0, 13), 16) / 2 ** 52
  if (parseInt(h.slice(0, 8), 16) % 33 === 0) return 1
  return Math.min(100, Math.max(1, +(0.97 / (1 - r)).toFixed(2)))
}

export const sportsList = [
  { id: 14, name: 'Football', sw: 'Mpira wa Miguu' },
  { id: 1, name: 'Basketball', sw: 'Mpira wa Kikapu' },
  { id: 2, name: 'Tennis', sw: 'Tenisi' },
  { id: 3, name: 'Cricket', sw: 'Kriketi' },
  { id: 4, name: 'Rugby', sw: 'Raga' },
  { id: 5, name: 'Volleyball', sw: 'Mpira wa Wavu' },
  { id: 6, name: 'Ice Hockey', sw: 'Hoki ya Barafu' },
  { id: 7, name: 'Table Tennis', sw: 'Tenisi ya Meza' },
  { id: 8, name: 'Boxing', sw: 'Ndondi' },
  { id: 9, name: 'American Football', sw: 'Soka ya Marekani' },
  { id: 10, name: 'Baseball', sw: 'Baseball' },
  { id: 11, name: 'Handball', sw: 'Handiboli' },
  { id: 12, name: 'eSoccer', sw: 'eSoccer' },
  { id: 13, name: 'Counter-Strike', sw: 'Counter-Strike' },
  { id: 15, name: 'Darts', sw: 'Darts' },
  { id: 16, name: 'MMA', sw: 'MMA' },
  { id: 17, name: 'Badminton', sw: 'Badminton' },
  { id: 18, name: 'Futsal', sw: 'Futsal' },
].map((s) => ({
  ...s,
  totalMatches: matches.filter((m) => m.sport === s.name).length || (s.id * 3 % 20 + 5),
  liveMatches: matches.filter((m) => m.sport === s.name && m.live).length,
}))

function requireSandboxAdmin(req: FastifyRequest) {
  if (!req.auth) throw new ApiError(401, 'unauthenticated')
  if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
}

function requireSession(req: FastifyRequest) {
  if (!req.auth) throw new ApiError(401, 'unauthenticated')
}

export function registerPublicRoutes(app: FastifyInstance) {
  app.get('/api/crash/current', async () => ({ serverSeedHash: currentHash, nonce, rtp: 0.97, publishedRtp: '97%' }))
  app.post('/api/crash/start', async (req) => {
    requireSandboxAdmin(req)
    const body = (req.body ?? {}) as { clientSeed?: string; cashOutAt?: number }
    const clientSeed = body.clientSeed ?? 'ushindi'
    const mult = crashPoint(serverSeed, clientSeed, nonce)
    const revealed = serverSeed
    const hash = currentHash
    const n = nonce
    serverSeed = crypto.randomBytes(32).toString('hex')
    currentHash = crypto.createHash('sha256').update(serverSeed).digest('hex')
    nonce += 1
    return {
      crashMultiplier: mult,
      cashedOut: Boolean(body.cashOutAt && body.cashOutAt <= mult),
      payoutMultiplier: body.cashOutAt && body.cashOutAt <= mult ? body.cashOutAt : 0,
      verify: {
        serverSeed: revealed,
        serverSeedHash: hash,
        clientSeed,
        nonce: n,
        algorithm: 'HMAC_SHA256(serverSeed, clientSeed:nonce) -> max(1,0.97/(1-r)) cap 100x',
      },
    }
  })
  app.post('/api/payments/:kind', async (req) => {
    requireSandboxAdmin(req)
    const kind = (req.params as { kind: string }).kind
    const body = (req.body ?? {}) as { provider?: string; amount?: number; phone?: string }
    const provider = body.provider ?? 'M-Pesa'
    const amount = body.amount ?? 0
    if (!providers[provider]) return { error: 'unknown provider' }
    if (kind === 'withdraw' && !operatorConfig.withdrawalsEnabled) return { error: 'withdrawals_disabled' }
    const floor = kind === 'withdraw' ? operatorConfig.minWithdraw : operatorConfig.minDeposit
    if (!Number.isInteger(amount) || amount < floor) return { error: `minimum ${kind}`, min: floor }
    const result = kind === 'withdraw'
      ? await providers[provider].withdraw({ phone: body.phone ?? '', amount })
      : await providers[provider].deposit({ phone: body.phone ?? '', amount })
    audit.push({ actor: body.phone, action: kind, amount, provider, at: new Date().toISOString() })
    return { ...result, provider, amount, currency: 'TZS', sandbox: true, ledger: false }
  })
  app.post('/api/settle/:id', async (req) => {
    requireSandboxAdmin(req)
    const id = Number((req.params as { id: string }).id)
    audit.push({ actor: 'official-results', action: 'settle', matchId: id, at: new Date().toISOString() })
    return { result: 'settled_from_official_result_append_only_ledger', sandbox: true }
  })

  const v1Matches = (query: { sport_id?: string; live?: string; tab?: string; page?: string; limit?: string }) => {
    let out = [...matches]
    if (query.sport_id) {
      out = out.filter((m) => sportsList.find((s) => s.name === m.sport)?.id === Number(query.sport_id))
    }
    if (query.live === 'true' || query.tab === 'live') out = out.filter((m) => m.live)
    const page = Number(query.page || 1)
    const limit = Number(query.limit || 10)
    return out.slice((page - 1) * limit, (page - 1) * limit + limit)
  }
  app.get('/v1/uo/matches', async (req) => {
    requireSession(req)
    return {
    data: v1Matches(req.query as { sport_id?: string; live?: string; tab?: string; page?: string; limit?: string }),
    meta: {
      total: matches.length,
      live: matches.filter((m) => m.live).length,
      marginBps: operatorConfig.marginBps,
      currency: 'TZS',
      tz: 'Africa/Dar_es_Salaam',
      sandbox: true,
      source: 'mock licensed-feed adapter with operator margin',
    },
  } })
  app.get('/v1/uo/sports', async (req) => {
    requireSession(req)
    return {
      data: sportsList,
      meta: { total: sportsList.length, live: matches.filter((m) => m.live).length },
    }
  })
  app.get('/v1/uo/totalMatches', async (req) => {
    requireSession(req)
    return {
      totalMatches: matches.length,
      liveMatches: matches.filter((m) => m.live).length,
      bySport: sportsList.map((s) => ({ sport_id: s.id, name: s.name, total: s.totalMatches, live: s.liveMatches })),
    }
  })
  app.get('/v1/uo/sport', async (req) => {
    requireSession(req)
    const id = Number((req.query as { id?: string }).id || 14)
    const sport = sportsList.find((item) => item.id === id)
    return { data: sport ?? null, matches: matches.filter((m) => m.sport === sport?.name), meta: { sport_id: id } }
  })
}
