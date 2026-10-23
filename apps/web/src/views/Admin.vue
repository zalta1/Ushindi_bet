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
