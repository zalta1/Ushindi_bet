import { defineStore } from 'pinia'
import { matches as seed } from '../data/mock'
import { api, ensureCsrf } from '../api'

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
  state: () => ({ items: [] as any[], stake: 1000, open: false }),
  getters: {
    combined: (s: any) => s.items.reduce((a: any, i: any) => a * i.price, 1),
    payout: (s: any) => s.items.reduce((a: any, i: any) => a * i.price, 1) * s.stake,
  },
  actions: {
    toggle(m: any, o: any) {
      const k = m.id + o.sel
      if (this.items.find((i: any) => i.key === k)) this.items = this.items.filter((i: any) => i.key !== k)
      else this.items.push({ key: k, match: `${m.home} vs ${m.away}`, sel: o.sel, price: o.price, matchId: m.id })
    },
    clear() { this.items = [] },
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
  state: () => ({ list: JSON.parse(JSON.stringify(seed)) as any[], selectedSport: 'All', loadedCount: 0 }),
  actions: {
    setSport(s: string) { this.selectedSport = s },
    loadMore() {
      import('../data/mock').then((m) => { this.list.push(...m.moreMatches(this.loadedCount)); this.loadedCount += 4 })
    },
    tick() {
      this.list.forEach((m: any) => {
        if (m.live) {
          m.minute = Math.min(90, m.minute + 1)
          m.odds = m.odds.map((o: any) => ({ ...o, price: Math.max(1.05, +(o.price + (Math.random() - 0.5) * 0.08).toFixed(2)) }))
        }
      })
    },
  },
})
