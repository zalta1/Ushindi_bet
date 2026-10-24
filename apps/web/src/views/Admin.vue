<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type SectionId =
  | 'overview' | 'transactions' | 'payment-api' | 'speedpesa-logs' | 'vodacom-deposits'
  | 'withdrawal-requests' | 'reports' | 'support' | 'sms' | 'users' | 'match-api' | 'matches'
  | 'two-up-markets' | 'aviator' | 'zungusha' | 'penalty' | 'jackpots' | 'casino-budget'
  | 'banners' | 'bets' | 'notifications' | 'announcements' | 'wallet-audit' | 'audit'
  | 'account' | 'admins' | 'settings'

const ready = new Set<SectionId>([
  'overview', 'users', 'banners', 'notifications', 'announcements',
  'wallet-audit', 'audit', 'account', 'admins', 'settings',
  'match-api', 'matches', 'bets', 'two-up-markets',
])

const menu: SectionId[] = [
  'overview', 'transactions', 'payment-api', 'speedpesa-logs', 'vodacom-deposits',
  'withdrawal-requests', 'reports', 'support', 'sms', 'users', 'match-api', 'matches',
  'two-up-markets', 'aviator', 'zungusha', 'penalty', 'jackpots', 'casino-budget',
  'banners', 'bets', 'notifications', 'announcements', 'wallet-audit', 'audit',
  'account', 'admins', 'settings',
]

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const section = ref<SectionId>('overview')
const status = ref('')
const error = ref('')

const overview = ref<{ users: number; betsToday: number; revenueTzs: number; activeMatches: number; newest: UserRow[] } | null>(null)
const users = ref<UserRow[]>([])
const query = ref('')
const selected = ref<UserDetail | null>(null)
const amountTzs = ref(1000)
const reason = ref('')
const admins = ref<UserRow[]>([])
const adminPhone = ref('')
const auditRows = ref<AuditRow[]>([])
const authEvents = ref<{ id: string; phone: string | null; event: string; created_at: string }[]>([])
const impersonations = ref<{ id: string; actor_phone: string; target_phone: string; reason: string; created_at: string; ended_at: string | null }[]>([])
const forceLogouts = ref<{ id: string; actor_phone: string; target_phone: string; reason: string; created_at: string }[]>([])
const fraudFlags = ref<{ flagType: string; phone: string | null; amountTzs: number | null; eventCount: number }[]>([])
const ledger = ref<LedgerRow[]>([])
const recon = ref<{ id: string; ran_at: string; wallets_checked: number; mismatches: number }[]>([])
const alerts = ref<{ id: string; phone: string | null; kind: string; status: string; detail: unknown }[]>([])
const walletTab = ref<'ledger' | 'recon' | 'alerts'>('ledger')
const banners = ref<Banner[]>([])
const bannerTitle = ref('')
const bannerUrl = ref('')
const announcements = ref<Announcement[]>([])
const messageSw = ref('')
const messageEn = ref('')
const notes = ref<Note[]>([])
const noteTitle = ref('')
const noteBody = ref('')
const notePhone = ref('')
const apiKeys = ref<ApiKeyRow[]>([])
const apiLabel = ref('')
const apiKey = ref('')
const adminMatches = ref<AdminMatch[]>([])
const twoUp = ref<TwoUpRow[]>([])
const twoQuery = ref('')
const twoOnly = ref(false)
const twoMsg = ref('')
const betFilter = ref<'all' | 'open' | 'won' | 'lost'>('all')
const betStats = ref<BetStats | null>(null)
const adminBets = ref<AdminBet[]>([])
const selectedMatch = ref<number | null>(null)
const matchForm = ref({ home: '', away: '', league: 'Ligi Kuu Tanzania', country: 'Tanzania', kickoff: '', status: 'upcoming', minute: 0, homeOdd: 2.1, drawOdd: 3.2, awayOdd: 2.8 })
const scoreHome = ref(0)
const scoreAway = ref(0)
const voidReason = ref('')

const cfg = ref({
  marginBps: 600,
  minStake: 500,
  maxStake: 500000,
  minWithdraw: 1000,
  maxWithdraw: 5000000,
  minDeposit: 30000,
  maxDeposit: 5000000,
  rtpBps: 9700,
  withdrawalsEnabled: true,
  cashoutEnabled: false,
  cashoutMarginBps: 1200,
  payoutPercentBps: 8800,
  feedSyncEnabled: false,
  lifecycleEnabled: false,
  hotMatchesAuto: false,
  feedSyncIntervalSec: 300,
  liveOddsIntervalSec: 60,
  lifecycleIntervalSec: 30,
  welcomeBonusEnabled: false,
  welcomeBonusTzs: 0,
  securityDepositTzs: 0,
  securityUnlockTzs: 0,
  agentWhatsapp: '',
  maintenanceMode: false,
})

type UserRow = {
  id: string
  phone: string
  fullName: string
  role: string
  balanceTzs: number
  createdAt: string
  closedAt: string | null
}
type UserDetail = { user: UserRow; ledger: LedgerRow[]; deposits: { id: string; amountTzs: number; status: string }[] }
type LedgerRow = { id: string; phone?: string; entryType: string; direction: string; amountTzs: number; balanceAfterTzs: number; reason: string | null; createdAt: string }
type AuditRow = { id: string; actor: string; action: string; created_at: string }
type Banner = { id: string; title: string; image_url: string; active: boolean; sort_order: number }
type Announcement = { id: string; message_sw: string; message_en: string; active: boolean }
type Note = { id: string; phone: string | null; title: string; body: string }
type ApiKeyRow = { source: 'system' | 'custom'; id: string | null; label: string; masked: string; is_active: boolean; check?: { ok: boolean; message?: string } | null }
type Outcome = { sel: string; price: number; oddsId: number; market: string; suspended?: boolean }
type AdminMatch = { id: number; home: string; away: string; league: string; country: string; kickoff: string; status: string; live: boolean; minute: number; hs: number; as: number; hot?: boolean; markets: Record<string, Outcome[]> }
type TwoUpRow = { id: number; home: string; away: string; league: string; kickoff: string; enabled: boolean; homeOdds: number | null; drawOdds: number | null; awayOdds: number | null; team: string }
type BetStats = { total: number; open: number; won: number; lost: number; totalStakes: number; totalPayouts: number }
type AdminBet = { id: string; phone: string; stakeTzs: number; combinedOdds: number; potentialPayoutTzs: number; status: string; legs: { match: string; market: string; selection: string; odds: number; status: string }[] }

const allowed = computed(() => Boolean(auth.user?.admin))
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

function fail(err: unknown) {
  error.value = err instanceof ApiClientError ? err.code : 'error'
}

async function loadOverview() {
  overview.value = await api('/api/admin/overview')
}

async function loadUsers() {
  const q = query.value.trim()
  const data = await api<{ data: UserRow[] }>(`/api/admin/users?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`)
  users.value = data.data
}

async function openUser(id: string) {
  selected.value = await api<UserDetail>(`/api/admin/users/${id}`)
  error.value = ''
}

async function loadAdmins() {
  admins.value = (await api<{ data: UserRow[] }>('/api/admin/admins')).data
}

async function loadAudit() {
  auditRows.value = (await api<{ data: AuditRow[] }>('/api/admin/audit')).data
  authEvents.value = (await api<{ data: typeof authEvents.value }>('/api/admin/auth-events')).data
  impersonations.value = (await api<{ data: typeof impersonations.value }>('/api/admin/impersonations')).data
  forceLogouts.value = (await api<{ data: typeof forceLogouts.value }>('/api/admin/force-logouts')).data
  fraudFlags.value = (await api<{ data: typeof fraudFlags.value }>('/api/admin/fraud-flags')).data
}

async function loadWallet() {
  ledger.value = (await api<{ data: LedgerRow[] }>('/api/admin/ledger')).data
  recon.value = (await api<{ data: typeof recon.value }>('/api/admin/reconciliation')).data
  alerts.value = (await api<{ data: typeof alerts.value }>('/api/admin/fraud-alerts')).data
}

async function loadContent() {
  banners.value = (await api<{ data: Banner[] }>('/api/admin/banners')).data
  announcements.value = (await api<{ data: Announcement[] }>('/api/admin/announcements')).data
  notes.value = (await api<{ data: Note[] }>('/api/admin/notifications')).data
}

async function loadSettings() {
  const remote = await api<typeof cfg.value>('/api/admin/config')
  cfg.value = { ...cfg.value, ...remote }
}

async function loadMatchApi() {
  const data = await api<{ keys: ApiKeyRow[] }>('/api/admin/match-api')
  apiKeys.value = data.keys
}

async function addApiKey() {
  error.value = ''
  try {
    await api('/api/admin/match-api', { method: 'POST', json: { label: apiLabel.value || 'API-Football', apiKey: apiKey.value } })
    apiLabel.value = ''
    apiKey.value = ''
    status.value = 'saved'
    await loadMatchApi()
  } catch (err) {
    fail(err)
  }
}

async function toggleApiKey(row: ApiKeyRow) {
  if (!row.id) return
  error.value = ''
  try {
    await api(`/api/admin/match-api/${row.id}/toggle`, { method: 'POST', json: {} })
    await loadMatchApi()
  } catch (err) {
    fail(err)
  }
}

async function deleteApiKey(row: ApiKeyRow) {
  if (!row.id) return
  error.value = ''
  try {
    await api(`/api/admin/match-api/${row.id}/delete`, { method: 'POST', json: {} })
    await loadMatchApi()
  } catch (err) {
    fail(err)
  }
}

async function checkApiKey(row: ApiKeyRow) {
  if (!row.id) return
  error.value = ''
  try {
    const check = await api<{ ok: boolean; message?: string }>(`/api/admin/match-api/${row.id}/check`, { method: 'POST', json: {} })
    row.check = check
  } catch (err) {
    fail(err)
  }
}

async function syncMatches() {
  error.value = ''
  try {
    await api('/api/admin/matches/sync', { method: 'POST', json: {} })
    status.value = 'saved'
    await loadAdminMatches()
  } catch (err) {
    fail(err)
  }
}

async function loadAdminMatches() {
  adminMatches.value = (await api<{ data: AdminMatch[] }>('/api/admin/matches')).data
  if (selectedMatch.value == null && adminMatches.value[0]) selectedMatch.value = adminMatches.value[0].id
}

async function createMatch() {
  error.value = ''
  try {
    await api('/api/admin/matches', {
      method: 'POST',
      json: {
        home: matchForm.value.home,
        away: matchForm.value.away,
        league: matchForm.value.league,
        country: matchForm.value.country,
        kickoff: matchForm.value.kickoff || new Date(Date.now() + 3_600_000).toISOString(),
        status: matchForm.value.status,
        minute: matchForm.value.minute,
        odds: { home: matchForm.value.homeOdd, draw: matchForm.value.drawOdd, away: matchForm.value.awayOdd },
      },
    })
    matchForm.value.home = ''
    matchForm.value.away = ''
    status.value = 'saved'
    await loadAdminMatches()
  } catch (err) {
    fail(err)
  }
}

async function settleMatch(id: number) {
  error.value = ''
  try {
    await api(`/api/admin/matches/${id}/settle`, { method: 'POST', json: { homeScore: Number(scoreHome.value), awayScore: Number(scoreAway.value) } })
    status.value = 'saved'
    await loadAdminMatches()
  } catch (err) {
    fail(err)
  }
}

async function voidMatch(id: number) {
  error.value = ''
  try {
    await api(`/api/admin/matches/${id}/void`, { method: 'POST', json: { reason: voidReason.value } })
    status.value = 'saved'
    voidReason.value = ''
    await loadAdminMatches()
  } catch (err) {
    fail(err)
  }
}

async function toggleHot(match: AdminMatch) {
  error.value = ''
  await api(`/api/admin/matches/${match.id}/hot`, { method: 'POST', json: { hot: !match.hot } })
  status.value = 'saved'
  await loadAdminMatches()
}

async function loadTwoUp() {
  const data = await api<{ data: TwoUpRow[] }>(`/api/admin/two-up?q=${encodeURIComponent(twoQuery.value)}&enabled=${twoOnly.value ? 'true' : 'false'}`)
  twoUp.value = data.data.map((row) => ({
    ...row,
    homeOdds: row.homeOdds ?? 1.9,
    drawOdds: row.drawOdds ?? 3.4,
    awayOdds: row.awayOdds ?? 4.1,
    team: row.team || 'both',
  }))
}

async function saveTwoUp(row: TwoUpRow) {
  twoMsg.value = ''
  error.value = ''
  try {
    await api(`/api/admin/matches/${row.id}/two-up`, {
      method: 'POST',
      json: {
        enabled: row.enabled,
        homeOdds: Number(row.homeOdds),
        drawOdds: Number(row.drawOdds),
        awayOdds: Number(row.awayOdds),
        team: row.team || 'both',
      },
    })
    twoMsg.value = '2UP imesasishwa'
    status.value = 'saved'
    await loadTwoUp()
  } catch (err) {
    twoMsg.value = 'Odds zote (Home/Draw/Away) lazima ziwe 1.01 au zaidi'
    fail(err)
  }
}

async function loadAdminBets() {
  const q = betFilter.value === 'all' ? '' : `?status=${betFilter.value}`
  const data = await api<{ stats: BetStats; data: AdminBet[] }>(`/api/admin/bets${q}`)
  betStats.value = data.stats
  adminBets.value = data.data
}

async function refresh() {
  error.value = ''
  if (!allowed.value) return
  try {
    if (section.value === 'overview') await loadOverview()
    if (section.value === 'users' || section.value === 'account') await loadUsers()
    if (section.value === 'admins') await loadAdmins()
    if (section.value === 'audit') await loadAudit()
    if (section.value === 'wallet-audit') await loadWallet()
    if (section.value === 'banners' || section.value === 'announcements' || section.value === 'notifications') await loadContent()
    if (section.value === 'settings') await loadSettings()
    if (section.value === 'match-api') await loadMatchApi()
    if (section.value === 'matches') await loadAdminMatches()
    if (section.value === 'bets') await loadAdminBets()
    if (section.value === 'two-up-markets') await loadTwoUp()
  } catch (err) {
    fail(err)
  }
}

onMounted(async () => {
  if (!auth.bootstrapped) await auth.bootstrap()
  await refresh()
})
watch(section, () => { status.value = ''; void refresh() })

async function saveSettings() {
  status.value = ''
  error.value = ''
  try {
    const saved = await api<typeof cfg.value>('/api/admin/config', { method: 'PATCH', json: cfg.value })
    cfg.value = { ...cfg.value, ...saved }
    status.value = 'saved'
  } catch (err) {
    fail(err)
  }
}

async function adjust(direction: 'credit' | 'debit') {
  if (!selected.value) return
  error.value = ''
  status.value = ''
  try {
    await api(`/api/admin/users/${selected.value.user.id}/adjust`, {
      method: 'POST',
      json: { direction, amountTzs: Number(amountTzs.value), reason: reason.value },
    })
    status.value = 'saved'
    reason.value = ''
    await openUser(selected.value.user.id)
    await loadUsers()
  } catch (err) {
    fail(err)
  }
}

async function forceLogout(id: string) {
  error.value = ''
  try {
    await api(`/api/admin/users/${id}/force-logout`, { method: 'POST', json: { reason: reason.value } })
    status.value = 'saved'
  } catch (err) {
    fail(err)
  }
}

async function impersonate(id: string) {
  error.value = ''
  try {
    await api(`/api/admin/users/${id}/impersonate`, { method: 'POST', json: { reason: reason.value } })
    await auth.loadMe()
    await router.push('/')
  } catch (err) {
    fail(err)
  }
}

async function closeUser(id: string) {
  error.value = ''
  try {
    await api(`/api/admin/users/${id}/close`, { method: 'POST', json: { reason: reason.value } })
    status.value = 'saved'
    reason.value = ''
    await loadUsers()
  } catch (err) {
    fail(err)
  }
}

async function addAdmin() {
  error.value = ''
  try {
    await api('/api/admin/admins', { method: 'POST', json: { phone: adminPhone.value } })
    adminPhone.value = ''
    status.value = 'saved'
    await loadAdmins()
  } catch (err) {
    fail(err)
  }
}

async function revokeAdmin(id: string) {
  error.value = ''
  try {
    await api(`/api/admin/admins/${id}/revoke`, { method: 'POST', json: {} })
    status.value = 'saved'
    await loadAdmins()
  } catch (err) {
    fail(err)
  }
}

async function reconcile() {
  error.value = ''
  try {
    await api('/api/admin/reconcile/wallets', { method: 'POST', json: {} })
    status.value = 'saved'
    await loadWallet()
  } catch (err) {
    fail(err)
  }
}

async function resolveAlert(id: string) {
  error.value = ''
  try {
    await api(`/api/admin/fraud-alerts/${id}/resolve`, { method: 'POST', json: { reason: reason.value || 'reviewed' } })
    await loadWallet()
  } catch (err) {
    fail(err)
  }
}

async function addBanner() {
  error.value = ''
  try {
    await api('/api/admin/banners', { method: 'POST', json: { title: bannerTitle.value, imageUrl: bannerUrl.value, active: true, sortOrder: banners.value.length } })
    bannerTitle.value = ''
    bannerUrl.value = ''
    await loadContent()
  } catch (err) {
    fail(err)
  }
}

async function toggleBanner(row: Banner) {
  await api(`/api/admin/banners/${row.id}`, { method: 'PATCH', json: { active: !row.active } })
  await loadContent()
}

async function deleteBanner(id: string) {
  await api(`/api/admin/banners/${id}/delete`, { method: 'POST', json: {} })
  await loadContent()
}

async function addAnnouncement() {
  error.value = ''
  try {
    await api('/api/admin/announcements', { method: 'POST', json: { messageSw: messageSw.value, messageEn: messageEn.value, active: true } })
    messageSw.value = ''
    messageEn.value = ''
    await loadContent()
  } catch (err) {
    fail(err)
  }
}

async function toggleAnnouncement(row: Announcement) {
  await api(`/api/admin/announcements/${row.id}`, { method: 'PATCH', json: { active: !row.active } })
  await loadContent()
}

async function deleteAnnouncement(id: string) {
  await api(`/api/admin/announcements/${id}/delete`, { method: 'POST', json: {} })
  await loadContent()
}

async function addNote() {
  error.value = ''
  try {
    await api('/api/admin/notifications', { method: 'POST', json: { title: noteTitle.value, body: noteBody.value, phone: notePhone.value } })
    noteTitle.value = ''
    noteBody.value = ''
    notePhone.value = ''
    await loadContent()
  } catch (err) {
    fail(err)
  }
}

async function deleteNote(id: string) {
  await api(`/api/admin/notifications/${id}/delete`, { method: 'POST', json: {} })
  await loadContent()
}
</script>

<template>
  <h2 v-if="!allowed" data-testid="admin-gate">{{ $t('adminDenied') }}</h2>
  <div v-else class="admin-shell" data-testid="admin-panel">
    <div class="admin-head">
      <div>
        <h2 data-testid="admin-title">{{ $t('adminTitle') }}</h2>
        <p class="muted">{{ $t('adminWelcome', { phone: auth.user?.phone }) }}</p>
      </div>
      <RouterLink to="/" class="admin-link">{{ $t('adminHome') }}</RouterLink>
    </div>

    <nav class="admin-nav" data-testid="admin-nav">
      <button
        v-for="id in menu"
        :key="id"
        type="button"
        :class="{ active: section === id }"
        :data-testid="`admin-nav-${id}`"
        @click="section = id"
      >{{ $t(`adminNav.${id}`) }}</button>
    </nav>

    <div v-if="section !== 'overview'" class="admin-back">
      <button type="button" @click="section = 'overview'" data-testid="admin-back">{{ $t('adminBack') }}</button>
      <h3 data-testid="admin-section-title">{{ $t(`adminNav.${section}`) }}</h3>
    </div>
    <p v-if="error" class="form-error" data-testid="admin-error">{{ error }}</p>
    <p v-if="status === 'saved'" data-testid="admin-status">{{ $t('adminSaved') }}</p>

    <section v-if="section === 'overview'" data-testid="admin-overview">
      <h3>{{ $t('adminOverviewTitle') }}</h3>
      <p class="muted">{{ $t('adminOverviewSub') }}</p>
      <div class="admin-stats" v-if="overview">
        <article data-testid="admin-stat-users"><b>{{ overview.users }}</b><span>{{ $t('adminStatUsers') }}</span></article>
        <article data-testid="admin-stat-bets"><b>{{ overview.betsToday }}</b><span>{{ $t('adminStatBets') }}</span></article>
        <article data-testid="admin-stat-revenue"><b>{{ money(overview.revenueTzs) }}</b><span>{{ $t('adminStatRevenue') }}</span></article>
        <article data-testid="admin-stat-matches"><b>{{ overview.activeMatches }}</b><span>{{ $t('adminStatMatches') }}</span></article>
      </div>
      <div class="admin-tiles">
        <button v-for="id in menu.filter((id) => id !== 'overview')" :key="id" type="button" @click="section = id">
          {{ $t(`adminNav.${id}`) }}
          <small v-if="!ready.has(id)">{{ $t('adminComing') }}</small>
        </button>
      </div>
      <h3>{{ $t('adminNewUsers') }}</h3>
      <button type="button" class="texty" @click="section = 'users'">{{ $t('adminSeeAll') }}</button>
      <div v-for="user in overview?.newest ?? []" :key="user.id" class="admin-row">
        <span>{{ user.fullName || user.phone }}</span>
        <span>{{ user.phone }}</span>
        <b>{{ money(user.balanceTzs) }}</b>
      </div>
      <p v-if="!overview?.newest.length" class="muted">{{ $t('adminNoRows') }}</p>
    </section>

    <section v-else-if="!ready.has(section)" class="card" data-testid="admin-coming">
      <h3>{{ $t('adminComing') }}</h3>
      <p>{{ $t('adminComingBody') }}</p>
    </section>

    <section v-else-if="section === 'settings'" data-testid="admin-settings">
      <label>Min deposit (TZS)<input type="number" v-model.number="cfg.minDeposit" data-testid="admin-min-deposit" /></label>
      <label>Max deposit (TZS)<input type="number" v-model.number="cfg.maxDeposit" /></label>
      <label>Min withdraw (TZS)<input type="number" v-model.number="cfg.minWithdraw" /></label>
      <label>Max withdraw (TZS)<input type="number" v-model.number="cfg.maxWithdraw" /></label>
      <label>Min stake<input type="number" v-model.number="cfg.minStake" /></label>
      <label>Max stake<input type="number" v-model.number="cfg.maxStake" /></label>
      <label>Margin (bps)<input type="number" v-model.number="cfg.marginBps" data-testid="admin-margin" /></label>
      <label>Welcome bonus (TZS)<input type="number" v-model.number="cfg.welcomeBonusTzs" /></label>
      <label>Security deposit<input type="number" v-model.number="cfg.securityDepositTzs" /></label>
      <label>Security unlock<input type="number" v-model.number="cfg.securityUnlockTzs" /></label>
      <label>WhatsApp<input v-model="cfg.agentWhatsapp" data-testid="admin-whatsapp" /></label>
      <label class="check"><input type="checkbox" v-model="cfg.withdrawalsEnabled" /> Utoaji / Withdrawals</label>
      <label class="check"><input type="checkbox" v-model="cfg.cashoutEnabled" /> Cash out</label>
      <label>Win payout (bps)<input type="number" v-model.number="cfg.payoutPercentBps" min="1" max="10000" data-testid="admin-payout-percent" /></label>
      <p class="muted">8800 = 88% ya ushindi (dau × odds) na 2UP. Futa na marejesho ni 100%. Asilimia inafungwa kwenye tiketi.</p>
      <label>Cash out margin (bps)<input type="number" v-model.number="cfg.cashoutMarginBps" data-testid="admin-cashout-margin" /></label>
      <p class="muted">1200 = 12% ya cash out. Hii si malipo ya ushindi, na cash out hauzidi kiasi cha ushindi.</p>
      <label class="check"><input type="checkbox" v-model="cfg.feedSyncEnabled" /> API-Football import / odds</label>
      <label class="check"><input type="checkbox" v-model="cfg.lifecycleEnabled" /> Auto start, live minute, full time</label>
      <label class="check"><input type="checkbox" v-model="cfg.hotMatchesAuto" /> HOT otomatiki (mechi 3 za live)</label>
      <label>Import (sekunde)<input type="number" v-model.number="cfg.feedSyncIntervalSec" /></label>
      <label>Live odds (sekunde)<input type="number" v-model.number="cfg.liveOddsIntervalSec" /></label>
      <label>Lifecycle (sekunde)<input type="number" v-model.number="cfg.lifecycleIntervalSec" /></label>
      <label class="check"><input type="checkbox" v-model="cfg.welcomeBonusEnabled" /> Bonus</label>
      <label class="check"><input type="checkbox" v-model="cfg.maintenanceMode" /> Maintenance</label>
      <p class="muted">TZS</p>
      <button type="button" @click="saveSettings" data-testid="admin-save">{{ $t('adminSave') }}</button>
    </section>

    <section v-else-if="section === 'users'" data-testid="admin-users">
      <form @submit.prevent="loadUsers">
        <input v-model="query" :placeholder="$t('adminSearch')" data-testid="admin-user-search" />
        <button type="submit">{{ $t('adminSearch') }}</button>
      </form>
      <div v-for="user in users" :key="user.id" class="admin-row">
        <button type="button" @click="openUser(user.id)">{{ user.phone }}</button>
        <span>{{ user.fullName }}</span>
        <span>{{ user.role }}</span>
        <b>{{ money(user.balanceTzs) }}</b>
        <span v-if="user.closedAt">closed</span>
      </div>
      <div v-if="selected" class="card" data-testid="admin-user-detail">
        <h3>{{ selected.user.phone }}</h3>
        <p>{{ money(selected.user.balanceTzs) }} · {{ selected.user.role }}</p>
        <label>{{ $t('adminAmount') }}<input type="number" v-model.number="amountTzs" data-testid="admin-adjust-amount" /></label>
        <label>{{ $t('adminReason') }}<input v-model="reason" data-testid="admin-reason" /></label>
        <button type="button" @click="adjust('credit')" data-testid="admin-credit">{{ $t('adminCredit') }}</button>
        <button type="button" @click="adjust('debit')" data-testid="admin-debit">{{ $t('adminDebit') }}</button>
        <button type="button" @click="forceLogout(selected.user.id)" data-testid="admin-force-logout">{{ $t('adminForceLogout') }}</button>
        <button type="button" @click="impersonate(selected.user.id)" data-testid="admin-impersonate">{{ $t('adminImpersonate') }}</button>
        <h4>{{ $t('adminLedger') }}</h4>
        <p v-for="row in selected.ledger" :key="row.id">{{ row.direction }} {{ money(row.amountTzs) }} {{ row.entryType }} <span v-if="row.reason">— {{ row.reason }}</span></p>
      </div>
    </section>

    <section v-else-if="section === 'account'" data-testid="admin-accounts">
      <p>{{ $t('adminCloseHelp') }}</p>
      <label>{{ $t('adminReason') }}<input v-model="reason" data-testid="admin-close-reason" /></label>
      <div v-for="user in users" :key="user.id" class="admin-row">
        <span>{{ user.phone }}</span>
        <span>{{ user.role }}</span>
        <span v-if="user.closedAt">closed</span>
        <button v-else type="button" @click="closeUser(user.id)">{{ $t('adminClose') }}</button>
      </div>
    </section>

    <section v-else-if="section === 'admins'" data-testid="admin-admins">
      <form @submit.prevent="addAdmin">
        <input v-model="adminPhone" placeholder="07XXXXXXXX" data-testid="admin-add-phone" />
        <button type="submit" data-testid="admin-add">{{ $t('adminAddAdmin') }}</button>
      </form>
      <p class="muted">{{ $t('adminLast') }}</p>
      <div v-for="user in admins" :key="user.id" class="admin-row">
        <span>{{ user.phone }}</span>
        <span v-if="user.closedAt">closed</span>
        <button v-else type="button" @click="revokeAdmin(user.id)" :data-testid="`admin-revoke-${user.phone}`">{{ $t('adminRemoveAdmin') }}</button>
      </div>
    </section>

    <section v-else-if="section === 'audit'" data-testid="admin-audit">
      <h3>Audit</h3>
      <p v-if="!auditRows.length" class="muted">{{ $t('adminNoRows') }}</p>
      <p v-for="row in auditRows" :key="row.id">{{ row.created_at }} · {{ row.actor }} · {{ row.action }}</p>
      <h3>Auth</h3>
      <p v-for="row in authEvents" :key="row.id">{{ row.created_at }} · {{ row.phone }} · {{ row.event }}</p>
      <h3>Impersonation</h3>
      <p v-for="row in impersonations" :key="row.id">{{ row.actor_phone }} → {{ row.target_phone }} · {{ row.reason }}</p>
      <h3>Force logout</h3>
      <p v-for="row in forceLogouts" :key="row.id">{{ row.actor_phone }} → {{ row.target_phone }} · {{ row.reason }}</p>
      <h3>Fraud flags</h3>
      <p v-for="(row, i) in fraudFlags" :key="i">{{ row.flagType }} · {{ row.phone }} · {{ row.eventCount }}</p>
    </section>

    <section v-else-if="section === 'wallet-audit'" data-testid="admin-wallet">
      <div class="chips">
        <button type="button" :class="{ active: walletTab === 'ledger' }" @click="walletTab = 'ledger'">{{ $t('adminLedger') }}</button>
        <button type="button" :class="{ active: walletTab === 'recon' }" @click="walletTab = 'recon'">{{ $t('adminRecon') }}</button>
        <button type="button" :class="{ active: walletTab === 'alerts' }" @click="walletTab = 'alerts'">{{ $t('adminAlerts') }}</button>
      </div>
      <template v-if="walletTab === 'ledger'">
        <p v-if="!ledger.length" class="muted">{{ $t('adminNoRows') }}</p>
        <p v-for="row in ledger" :key="row.id">{{ row.phone }} · {{ row.direction }} {{ money(row.amountTzs) }} · {{ row.entryType }} <span v-if="row.reason">— {{ row.reason }}</span></p>
      </template>
      <template v-else-if="walletTab === 'recon'">
        <button type="button" @click="reconcile" data-testid="admin-reconcile">{{ $t('adminReconcile') }}</button>
        <p v-for="row in recon" :key="row.id">{{ row.ran_at }} · {{ row.wallets_checked }} wallets · {{ row.mismatches }} mismatches</p>
      </template>
      <template v-else>
        <label>{{ $t('adminReason') }}<input v-model="reason" /></label>
        <p v-if="!alerts.length" class="muted">{{ $t('adminNoRows') }}</p>
        <div v-for="row in alerts" :key="row.id" class="admin-row">
          <span>{{ row.phone }} · {{ row.kind }} · {{ row.status }}</span>
          <button v-if="row.status === 'open'" type="button" @click="resolveAlert(row.id)">{{ $t('adminResolve') }}</button>
        </div>
      </template>
    </section>

    <section v-else-if="section === 'banners'" data-testid="admin-banners">
      <input v-model="bannerTitle" placeholder="Title" data-testid="admin-banner-title" />
      <input v-model="bannerUrl" placeholder="https://..." data-testid="admin-banner-url" />
      <button type="button" @click="addBanner" data-testid="admin-banner-add">{{ $t('adminSave') }}</button>
      <div v-for="row in banners" :key="row.id" class="admin-row">
        <span>{{ row.title }}</span>
        <span>{{ row.active ? 'on' : 'off' }}</span>
        <button type="button" @click="toggleBanner(row)">{{ row.active ? 'Hide' : 'Show' }}</button>
        <button type="button" @click="deleteBanner(row.id)">×</button>
      </div>
    </section>

    <section v-else-if="section === 'announcements'" data-testid="admin-announcements">
      <input v-model="messageSw" placeholder="Kiswahili" data-testid="admin-announcement-sw" />
      <input v-model="messageEn" placeholder="English" data-testid="admin-announcement-en" />
      <button type="button" @click="addAnnouncement" data-testid="admin-announcement-add">{{ $t('adminSave') }}</button>
      <div v-for="row in announcements" :key="row.id" class="admin-row">
        <span>{{ row.message_sw }}</span>
        <button type="button" @click="toggleAnnouncement(row)">{{ row.active ? 'Hide' : 'Show' }}</button>
        <button type="button" @click="deleteAnnouncement(row.id)">×</button>
      </div>
    </section>

    <section v-else-if="section === 'match-api'" data-testid="admin-match-api">
      <div class="card">
        <h3>Ongeza API ya Mechi (API-Football)</h3>
        <input v-model="apiLabel" placeholder="Jina (mf. Akaunti ya 3)" data-testid="match-api-label" />
        <input v-model="apiKey" placeholder="Bandika API key hapa" data-testid="match-api-key" />
        <button type="button" @click="addApiKey" data-testid="match-api-add">Ongeza API</button>
      </div>
      <div class="admin-row">
        <h3>API za sasa ({{ apiKeys.length }})</h3>
        <button type="button" @click="loadMatchApi">Kagua</button>
      </div>
      <p v-if="!apiKeys.length" class="muted">Hakuna API bado.</p>
      <div v-for="row in apiKeys" :key="row.id || row.label" class="card">
        <b>{{ row.label }}</b>
        <p class="muted">{{ row.masked }}</p>
        <p v-if="row.check">{{ row.check.ok ? 'Inafanya kazi' : 'Haifanyi kazi' }} <span v-if="row.check.message && !row.check.ok">— {{ row.check.message }}</span></p>
        <template v-if="row.source === 'custom' && row.id">
          <button type="button" @click="checkApiKey(row)">Kagua</button>
          <button type="button" @click="toggleApiKey(row)">{{ row.is_active ? 'Zima' : 'Washa' }}</button>
          <button type="button" @click="deleteApiKey(row)">Futa</button>
        </template>
        <p v-else class="muted">Ufunguo wa mfumo (umehifadhiwa kwa usalama)</p>
      </div>
    </section>

    <section v-else-if="section === 'matches'" data-testid="admin-matches">
      <div class="card">
        <h3>Ongeza mechi</h3>
        <p class="muted">API-Football inaleta mechi ikiwa ufunguo upo. Bila ufunguo, weka mechi hapa.</p>
        <button type="button" @click="syncMatches" data-testid="matches-sync">Leta mechi kutoka API-Football</button>
        <label>Nyumbani<input v-model="matchForm.home" data-testid="match-home" /></label>
        <label>Ugenini<input v-model="matchForm.away" data-testid="match-away" /></label>
        <label>Ligi<input v-model="matchForm.league" /></label>
        <label>Nchi<input v-model="matchForm.country" /></label>
        <label>Muda<input type="datetime-local" v-model="matchForm.kickoff" /></label>
        <label>Hali
          <select v-model="matchForm.status">
            <option value="upcoming">Inayokuja</option>
            <option value="live">Mubashara</option>
          </select>
        </label>
        <label>Odds 1<input type="number" step="0.01" v-model.number="matchForm.homeOdd" /></label>
        <label>Odds X<input type="number" step="0.01" v-model.number="matchForm.drawOdd" /></label>
        <label>Odds 2<input type="number" step="0.01" v-model.number="matchForm.awayOdd" /></label>
        <button type="button" @click="createMatch" data-testid="match-save">Hifadhi</button>
      </div>
      <div v-for="match in adminMatches" :key="match.id" class="card">
        <button type="button" @click="selectedMatch = match.id"><b>{{ match.home }} vs {{ match.away }}</b></button>
        <p class="muted">{{ match.league }} · {{ match.country }} · {{ match.status }} <span v-if="match.live">{{ match.minute }}'</span> {{ match.hs }}-{{ match.as }} <span v-if="match.hot" class="hot-badge">HOT</span></p>
        <button type="button" @click="toggleHot(match)" data-testid="hot-toggle">{{ match.hot ? 'Zima HOT' : 'Washa HOT' }}</button>
        <div v-if="selectedMatch === match.id">
          <p v-for="(outcomes, market) in match.markets" :key="market">
            {{ market }}:
            <span v-for="outcome in outcomes" :key="outcome.oddsId"> {{ outcome.sel }} {{ outcome.price.toFixed(2) }}</span>
          </p>
          <template v-if="match.status === 'upcoming' || match.status === 'live'">
            <label>Goli Nyumbani<input type="number" v-model.number="scoreHome" data-testid="score-home" /></label>
            <label>Goli Ugenini<input type="number" v-model.number="scoreAway" data-testid="score-away" /></label>
            <button type="button" @click="settleMatch(match.id)" data-testid="match-settle">Maliza mechi</button>
            <label>Sababu<input v-model="voidReason" data-testid="void-reason" /></label>
            <button type="button" @click="voidMatch(match.id)" data-testid="match-void">Futa mechi</button>
          </template>
        </div>
      </div>
    </section>

    <section v-else-if="section === 'two-up-markets'" data-testid="admin-two-up">
      <p class="muted">Soko hili linaonekana kwa wateja kama 2UP | Full Time tofauti na 1X2 ya kawaida.</p>
      <form @submit.prevent="loadTwoUp">
        <input v-model="twoQuery" placeholder="Tafuta kwa Team au Ligi" data-testid="two-up-search" />
        <label class="check"><input type="checkbox" v-model="twoOnly" @change="loadTwoUp" /> 2UP ON tu</label>
        <button type="submit">Tafuta</button>
      </form>
      <p v-if="twoMsg" data-testid="two-up-toast">{{ twoMsg }}</p>
      <p v-if="!twoUp.length" class="muted">Hakuna mechi</p>
      <div v-for="row in twoUp" :key="row.id" class="card" data-testid="two-up-row">
        <b>{{ row.home }} vs {{ row.away }}</b>
        <p class="muted">{{ row.league }}</p>
        <label class="check"><input type="checkbox" v-model="row.enabled" /> 2UP</label>
        <label>Home 2UP (1)<input type="number" step="0.01" v-model.number="row.homeOdds" data-testid="two-up-home" /></label>
        <label>Draw 2UP (X)<input type="number" step="0.01" v-model.number="row.drawOdds" data-testid="two-up-draw" /></label>
        <label>Away 2UP (2)<input type="number" step="0.01" v-model.number="row.awayOdds" data-testid="two-up-away" /></label>
        <label>Upande
          <select v-model="row.team">
            <option value="both">Pande zote</option>
            <option value="home">Nyumbani</option>
            <option value="away">Ugenini</option>
          </select>
        </label>
        <button type="button" @click="saveTwoUp(row)" data-testid="two-up-save">Hifadhi</button>
      </div>
    </section>

    <section v-else-if="section === 'bets'" data-testid="admin-bets">
      <div class="admin-stats" v-if="betStats">
        <article><b>{{ betStats.total }}</b><span>Bets Zote</span></article>
        <article><b>{{ betStats.open }}</b><span>Open</span></article>
        <article><b>{{ betStats.won }}</b><span>Won</span></article>
        <article><b>{{ betStats.lost }}</b><span>Lost</span></article>
      </div>
      <div class="admin-stats" v-if="betStats">
        <article><b>{{ money(betStats.totalStakes) }}</b><span>Total Stakes</span></article>
        <article><b>{{ money(betStats.totalPayouts) }}</b><span>Total Payouts</span></article>
      </div>
      <div class="chips">
        <span>Filter:</span>
        <button type="button" :class="{ active: betFilter === 'all' }" @click="betFilter = 'all'; loadAdminBets()">Zote</button>
        <button type="button" :class="{ active: betFilter === 'open' }" @click="betFilter = 'open'; loadAdminBets()">OPEN</button>
        <button type="button" :class="{ active: betFilter === 'won' }" @click="betFilter = 'won'; loadAdminBets()">WON</button>
        <button type="button" :class="{ active: betFilter === 'lost' }" @click="betFilter = 'lost'; loadAdminBets()">LOST</button>
      </div>
      <p v-if="!adminBets.length" class="muted">{{ $t('adminNoRows') }}</p>
      <div v-for="bet in adminBets" :key="bet.id" class="card" data-testid="admin-bet-row">
        <b>{{ bet.phone }}</b> · {{ bet.status.toUpperCase() }}
        <p>Stake {{ money(bet.stakeTzs) }} @ {{ bet.combinedOdds.toFixed(2) }} → {{ money(bet.potentialPayoutTzs) }}</p>
        <p v-for="(leg, i) in bet.legs" :key="i" class="muted">{{ leg.match }} · {{ leg.market }} {{ leg.selection }} @ {{ leg.odds.toFixed(2) }} · {{ leg.status }}</p>
      </div>
    </section>

    <section v-else-if="section === 'notifications'" data-testid="admin-notifications">
      <input v-model="noteTitle" placeholder="Title" data-testid="admin-note-title" />
      <input v-model="noteBody" placeholder="Body" data-testid="admin-note-body" />
      <input v-model="notePhone" placeholder="07… (empty = all)" data-testid="admin-note-phone" />
      <button type="button" @click="addNote" data-testid="admin-note-add">{{ $t('adminSave') }}</button>
      <div v-for="row in notes" :key="row.id" class="admin-row">
        <span>{{ row.title }} · {{ row.phone || 'all' }}</span>
        <button type="button" @click="deleteNote(row.id)">×</button>
      </div>
    </section>
  </div>
</template>
