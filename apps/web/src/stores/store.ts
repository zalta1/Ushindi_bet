import { defineStore } from 'pinia'
import { ApiClientError, api, ensureCsrf } from '../api'

export type SessionUser = {
  id: string
  phone: string
  fullName: string
  role: string
  kycStatus: string
  balanceTzs: number
  bonusBalanceTzs: number
  admin: boolean
  permissions: string[]
  readOnly?: boolean
  impersonatorUserId?: string | null
}

let boot: Promise<void> | null = null

export const useWallet = defineStore('wallet', {
  state: () => ({ balance: 125000, bonus: 10000, txns: [{ type: 'deposit', amount: 50000, at: 'Leo', provider: 'M-Pesa (mock)' }] as any[], dailyLimit: 200000, selfExcluded: false }),
  actions: {
    add(a: number, t: string, p = '') {
      this.balance += a
      this.txns.unshift({ type: t, amount: a, at: new Date().toLocaleString('sw-TZ', { timeZone: 'Africa/Dar_es_Salaam' }), provider: p })
    },
  },
})

export const useSlip = defineStore('slip', {
  state: () => ({
    items: [] as { key: string; match: string; sel: string; price: number; matchId: number; oddsId: number; market: string }[],
    stake: 1000,
    open: false,
    minStake: 500,
    maxStake: 500000,
    error: '',
    idempotencyKey: '',
    placing: false,
    payoutPercentBps: 8800,
    quotedPayout: 0,
    quoteSeq: 0,
  }),
  getters: {
    combined: (s) => (s.items.length ? s.items.reduce((a, i) => a * i.price, 1) : 0),
    payout: (s) => s.quotedPayout,
  },
  actions: {
    async loadLimits() {
      try {
        const data = await api<{ minStake: number; maxStake: number; payoutPercentBps?: number }>('/api/bets/limits')
        this.minStake = data.minStake
        this.maxStake = data.maxStake
        if (typeof data.payoutPercentBps === 'number' && Number.isInteger(data.payoutPercentBps)) {
          this.payoutPercentBps = data.payoutPercentBps
        }
        if (this.stake < data.minStake) this.stake = data.minStake
      } catch {
        // The form still shows the defaults from settings.
      }
      await this.refreshQuote()
    },
    async refreshQuote() {
      const seq = ++this.quoteSeq
      if (!this.items.length || !Number.isInteger(this.stake) || this.stake < 1) {
        this.quotedPayout = 0
        return
      }
      const params = new URLSearchParams()
      params.set('stake', String(this.stake))
      for (const item of this.items) params.append('price', String(item.price))
      try {
        const data = await api<{ potentialPayoutTzs: number; payoutPercentBps: number }>(`/api/bets/quote?${params}`)
        if (seq !== this.quoteSeq) return
        this.quotedPayout = data.potentialPayoutTzs
        if (typeof data.payoutPercentBps === 'number' && Number.isInteger(data.payoutPercentBps)) {
          this.payoutPercentBps = data.payoutPercentBps
        }
      } catch {
        if (seq === this.quoteSeq) this.quotedPayout = 0
      }
    },
    setStake(value: number) {
      this.stake = Number.isFinite(value) ? Math.round(value) : 0
      this.idempotencyKey = ''
      this.error = ''
      void this.refreshQuote()
    },
    toggle(m: { id: number; home: string; away: string }, o: { sel: string; price: number; oddsId?: number; market?: string }) {
      if (!o.oddsId) return
      const key = `${m.id}:${o.oddsId}`
      this.idempotencyKey = ''
      this.error = ''
      if (this.items.find((item) => item.key === key)) {
        this.items = this.items.filter((item) => item.key !== key)
        void this.refreshQuote()
        return
      }
      this.items = this.items.filter((item) => item.matchId !== m.id)
      this.items.push({
        key,
        match: `${m.home} vs ${m.away}`,
        sel: o.sel,
        price: o.price,
        matchId: m.id,
        oddsId: o.oddsId,
        market: o.market ?? '1X2',
      })
      void this.refreshQuote()
    },
    clear() {
      this.items = []
      this.idempotencyKey = ''
      this.error = ''
      this.quotedPayout = 0
    },
    async place() {
      const auth = useAuth()
      this.error = ''
      if (!this.items.length || this.placing) return false
      if (!auth.user) {
        this.error = 'unauthenticated'
        return false
      }
      if (!Number.isInteger(this.stake) || this.stake < this.minStake || this.stake > this.maxStake) {
        this.error = this.stake < this.minStake ? 'min' : 'max'
        return false
      }
      if (!this.idempotencyKey) this.idempotencyKey = crypto.randomUUID()
      this.placing = true
      try {
        await api('/api/bets', {
          method: 'POST',
          json: {
            idempotencyKey: this.idempotencyKey,
            stakeTzs: this.stake,
            legs: this.items.map((item) => ({ oddsId: item.oddsId, price: item.price })),
          },
        })
        this.items = []
        this.idempotencyKey = ''
        this.open = false
        await auth.loadMe()
        return true
      } catch (err) {
        this.error = err instanceof ApiClientError ? err.code : 'error'
        if (this.error === 'odds_changed') this.idempotencyKey = ''
        return false
      } finally {
        this.placing = false
      }
    },
  },
})

export const useAuth = defineStore('auth', {
  state: () => ({
    user: null as SessionUser | null,
    bootstrapped: false,
  }),
  actions: {
    async bootstrap() {
      if (this.bootstrapped) return
      if (!boot) {
        boot = this.loadMe().finally(() => {
          this.bootstrapped = true
          boot = null
        })
      }
      await boot
    },
    async loadMe() {
      try {
        const data = await api<{ user: SessionUser }>('/api/auth/me')
        this.user = data.user
      } catch {
        this.user = null
      }
    },
    async register(input: { phone: string; password: string }) {
      await ensureCsrf()
      const data = await api<{ user: SessionUser }>('/api/auth/register', { method: 'POST', json: input })
      this.user = data.user
    },
    async login(input: { phone: string; password: string }) {
      await ensureCsrf()
      const data = await api<{ user: SessionUser }>('/api/auth/login', { method: 'POST', json: input })
      this.user = data.user
    },
    async logout() {
      try {
        await ensureCsrf()
        await api('/api/auth/logout', { method: 'POST', json: {} })
      } finally {
        this.user = null
      }
    },
    async changePassword(currentPassword: string, newPassword: string) {
      const data = await api<{ user: SessionUser }>('/api/auth/change-password', {
        method: 'POST',
        json: { currentPassword, newPassword },
      })
      this.user = data.user
    },
  },
})

export const useMatches = defineStore('matches', {
  state: () => ({ list: [] as any[], selectedSport: 'All', loaded: false }),
  actions: {
    setSport(s: string) { this.selectedSport = s },
    async load() {
      try {
        this.list = await api<any[]>('/api/matches')
        this.loaded = true
      } catch {
        this.loaded = true
      }
    },
    tick() {
      // Prices stay on the server quote. A random tick would fail the odds recheck.
    },
  },
})
