<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ApiClientError, api } from '../api'

type AdminPlayer = {
  id: string
  userId: string
  phone: string
  panel: number
  stakeTzs: number
  autoCashout: number | null
  status: string
  multiplier: number | null
  payoutTzs: number
  suspended: boolean
}
type RoundLimits = {
  roundNo: number
  rtpBps: number
  minStakeTzs: number
  maxStakeTzs: number
  bettingMs: number
  crashedMs: number
  budgetEnabled: boolean
}
type PlayerReport = {
  userId: string
  phone: string
  suspended: boolean
  netPnlTzs: number
  stakesTzs: number
  payoutsTzs: number
  bets: number
  flags: { code: string, detail: string }[]
  history: {
    id: string
    roundNo: number
    stakeTzs: number
    payoutTzs: number
    status: string
    multiplier: number | null
    autoCashout: number | null
    crashPoint: number | null
  }[]
}

type Settings = {
  aviatorEnabled: boolean
  aviatorRtpBps: number
  aviatorMaxMultiplier: number
  aviatorMinStake: number
  aviatorMaxStake: number
  aviatorMaxWin: number
  aviatorBettingMs: number
  aviatorCrashedMs: number
}
type Round = {
  id: string
  roundNo: number
  status: string
  serverSeed: string | null
  serverSeedHash: string
  clientSeed: string
  nonce: number
  crashPoint: number | null
  rtpBps: number
}
type Chat = { id: string, body: string, phone: string, userId: string, deleted: boolean, createdAt: string }
type Live = {
  enabled: boolean
  phase: string
  multiplier: number
  countdownMs: number
  viewerCount: number
  openStakeTzs: number
  betCount: number
  round: { roundNo: number } | null
  players: AdminPlayer[]
  roundLimits: RoundLimits | null
}
type Pnl = { dayStakes: number, dayPayouts: number, dayProfit: number, allStakes: number, allPayouts: number, allProfit: number, allBets: number, rounds: number }
type Bet = { id: string, phone: string, panel: number, stakeTzs: number, payoutTzs: number, status: string, multiplier: number | null, autoCashout: number | null }
type Budget = {
  enabled: boolean
  budgetTzs: number
  totalBetsTzs: number
  totalPayoutsTzs: number
  budgetRemaining: number
  lossRate: number
  payoutCap: number
  payoutCapPercent: number
  isPayoutCapReached: boolean
  healthLabel: string
}
type LogRow = {
  kind: string
  at: string
  summary: string
  crashPoint: number | null
  serverSeed: string | null
  serverSeedHash: string | null
  action: string | null
}

const settings = ref<Settings | null>(null)
const live = ref<Live | null>(null)
const pnl = ref<Pnl | null>(null)
const rounds = ref<Round[]>([])
const chat = ref<Chat[]>([])
const bets = ref<Bet[]>([])
const players = ref<AdminPlayer[]>([])
const selected = ref('')
const player = ref<PlayerReport | null>(null)
const budget = ref<Budget | null>(null)
const budgetInput = ref<number | null>(null)
const logRows = ref<LogRow[]>([])
const logQ = ref('')
const logKind = ref('')
const playerQ = ref('')
const error = ref('')
const status = ref('')
const minutes = ref(10)
let timer: ReturnType<typeof setInterval> | undefined
let source: EventSource | undefined

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString('sw-TZ')}`

function applyFeed(data: { phase: string, multiplier: number, countdownMs: number, viewerCount: number, enabled: boolean, round: RoundLimits | null, players: AdminPlayer[] }) {
  const previous = live.value
  live.value = {
    enabled: data.enabled,
    phase: data.phase,
    multiplier: data.multiplier,
    countdownMs: data.countdownMs,
    viewerCount: data.viewerCount,
    openStakeTzs: data.players.filter((row) => row.status === 'active').reduce((sum, row) => sum + row.stakeTzs, 0),
    betCount: data.players.length,
    round: data.round,
    players: data.players,
    roundLimits: data.round,
  }
  players.value = data.players
  if (previous && previous.phase !== data.phase) void load().catch(() => undefined)
}

async function load() {
  const data = await api<{ live: Live, settings: Settings, pnl: Pnl, rounds: Round[], chat: Chat[], budget: Budget }>('/api/admin/aviator')
  live.value = data.live
  players.value = data.live.players ?? []
  if (!settings.value) settings.value = { ...data.settings }
  pnl.value = data.pnl
  rounds.value = data.rounds
  chat.value = data.chat
  budget.value = data.budget
  if (budgetInput.value == null) budgetInput.value = data.budget.budgetTzs
}

async function searchLog() {
  const params = new URLSearchParams()
  if (logQ.value.trim()) params.set('q', logQ.value.trim())
  if (logKind.value) params.set('kind', logKind.value)
  const data = await api<{ rows: LogRow[] }>(`/api/admin/aviator/activity?${params.toString()}`)
  logRows.value = data.rows
}

async function exportLog() {
  error.value = ''
  const params = new URLSearchParams({ format: 'csv' })
  if (logQ.value.trim()) params.set('q', logQ.value.trim())
  if (logKind.value) params.set('kind', logKind.value)
  const res = await fetch(`/api/admin/aviator/activity?${params.toString()}`, { credentials: 'include', cache: 'no-store' })
  if (!res.ok) {
    error.value = 'error'
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'aviator-activity.csv'
  link.click()
  URL.revokeObjectURL(url)
}

async function save() {
  if (!settings.value) return
  error.value = ''
  status.value = ''
  try {
    settings.value = await api<Settings>('/api/admin/aviator/settings', { method: 'PATCH', json: settings.value })
    status.value = 'saved'
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

async function saveBudget(patch: { budgetTzs?: number, enabled?: boolean, resetCounters?: boolean }) {
  error.value = ''
  status.value = ''
  try {
    budget.value = await api<Budget>('/api/admin/aviator/budget', { method: 'PATCH', json: patch })
    if (patch.budgetTzs !== undefined) budgetInput.value = patch.budgetTzs
    status.value = 'saved'
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
    await load().catch(() => undefined)
  }
}

function onBudgetToggle(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  void saveBudget({ enabled })
}

async function openRound(id: string) {
  selected.value = id
  const data = await api<{ bets: Bet[] }>(`/api/admin/aviator/rounds/${id}`)
  bets.value = data.bets
}

async function openPlayer(userId: string) {
  error.value = ''
  player.value = await api<PlayerReport>(`/api/admin/aviator/players/${userId}`)
}

async function findPlayer() {
  error.value = ''
  try {
    const params = new URLSearchParams({ phone: playerQ.value.trim() })
    player.value = await api<PlayerReport>(`/api/admin/aviator/players?${params.toString()}`)
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

async function suspend(userId: string) {
  await api(`/api/admin/aviator/players/${userId}/suspend`, { method: 'POST', json: { reason: 'admin' } })
  status.value = 'saved'
  await openPlayer(userId)
  await load()
}

async function unsuspend(userId: string) {
  await api(`/api/admin/aviator/players/${userId}/unsuspend`, { method: 'POST', json: {} })
  status.value = 'saved'
  await openPlayer(userId)
  await load()
}

async function removeChat(id: string) {
  await api(`/api/admin/aviator/chat/${id}/delete`, { method: 'POST', json: {} })
  await load()
}

async function mute(userId: string) {
  await api('/api/admin/aviator/mutes', { method: 'POST', json: { userId, minutes: minutes.value, reason: 'admin' } })
  status.value = 'saved'
}

async function unmute(userId: string) {
  await api(`/api/admin/aviator/mutes/${userId}/delete`, { method: 'POST', json: {} })
  await load()
}

function connect() {
  source = new EventSource('/api/admin/aviator/stream')
  source.onmessage = (event) => {
    try {
      applyFeed(JSON.parse(event.data) as {
        phase: string
        multiplier: number
        countdownMs: number
        viewerCount: number
        enabled: boolean
        round: RoundLimits | null
        players: AdminPlayer[]
      })
    } catch { /* the next event replaces a bad frame */ }
  }
}

onMounted(async () => {
  try {
    await load()
    await searchLog()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
  connect()
  timer = setInterval(() => { void load().catch(() => undefined) }, 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  source?.close()
})
</script>

<template>
  <div data-testid="admin-aviator">
    <p v-if="error" class="form-error">{{ error }}</p>
    <p v-if="status === 'saved'" data-testid="admin-aviator-saved">Imehifadhiwa</p>
    <p class="muted">Hakuna sehemu ya kuweka crash point wala kuchagua mshindi. RTP, kizidishi, dau, ushindi wa juu, muda wa kusubiri, na swichi ya bajeti vinaanza raundi ijayo. Bajeti inahesabu dau na malipo tu. Kuzima Aviator kunarudisha dau la raundi inayoendelea.</p>

    <div class="admin-stats" v-if="pnl" data-testid="admin-aviator-pnl">
      <article><b>{{ money(pnl.dayProfit) }}</b><span>Faida masaa 24</span></article>
      <article><b>{{ money(pnl.dayStakes) }}</b><span>Dau 24h</span></article>
      <article><b>{{ money(pnl.dayPayouts) }}</b><span>Malipo 24h</span></article>
      <article><b>{{ money(pnl.allProfit) }}</b><span>Faida yote</span></article>
    </div>

    <div class="card" v-if="live" data-testid="admin-aviator-live">
      <h3>Raundi ya sasa</h3>
      <p class="aviator-live-mult" data-testid="admin-aviator-live-mult">{{ live.multiplier.toFixed(2) }}x</p>
      <p>
        {{ live.phase }}
        <template v-if="live.round"> · #{{ live.round.roundNo }}</template>
        · dau {{ live.betCount }} ({{ money(live.openStakeTzs) }})
        · watazamaji {{ live.viewerCount }}
        <template v-if="live.phase === 'betting'"> · {{ Math.ceil(live.countdownMs / 1000) }}s</template>
      </p>
      <p class="muted">{{ live.enabled ? 'Mchezo upo hai' : 'Mchezo umezimwa' }}</p>
      <p v-if="live.roundLimits && settings" data-testid="admin-aviator-next-round">
        Raundi hii: RTP {{ live.roundLimits.rtpBps }} bps, dau {{ live.roundLimits.minStakeTzs }}–{{ live.roundLimits.maxStakeTzs }},
        subiri {{ live.roundLimits.bettingMs }} ms, baada ya kuanguka {{ live.roundLimits.crashedMs }} ms,
        bajeti {{ live.roundLimits.budgetEnabled ? 'ON' : 'OFF' }}.
        Ijayo: RTP {{ settings.aviatorRtpBps }} bps, dau {{ settings.aviatorMinStake }}–{{ settings.aviatorMaxStake }},
        subiri {{ settings.aviatorBettingMs }} ms.
      </p>
      <div class="aviator-admin-scroll">
        <table class="aviator-admin-table" data-testid="admin-aviator-live-players" :data-count="players.length">
          <thead>
            <tr>
              <th>Mchezaji</th>
              <th>Dau</th>
              <th>Auto</th>
              <th>Hali</th>
              <th>Cash out</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!players.length">
              <td colspan="5" class="muted">Hakuna dau kwenye raundi hii.</td>
            </tr>
            <tr v-for="row in players" :key="row.id" data-testid="admin-aviator-player-row" :data-status="row.status" :data-user="row.userId">
              <td><button type="button" @click="openPlayer(row.userId)">{{ row.phone }}</button></td>
              <td>{{ money(row.stakeTzs) }} · {{ row.panel }}</td>
              <td>{{ row.autoCashout == null ? '—' : row.autoCashout.toFixed(2) + 'x' }}</td>
              <td>{{ row.status }}<span v-if="row.suspended"> · amezuiliwa</span></td>
              <td>
                <template v-if="row.status === 'cashed_out' && row.multiplier != null">{{ row.multiplier.toFixed(2) }}x → {{ money(row.payoutTzs) }}</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <form class="card aviator-player-search" @submit.prevent="findPlayer">
      <h3>Mchezaji</h3>
      <label>Nambari
        <input v-model="playerQ" data-testid="admin-aviator-player-q" placeholder="07xxxxxxxx" />
      </label>
      <button type="submit" data-testid="admin-aviator-player-search">Fungua</button>
    </form>

    <div v-if="player" class="card" data-testid="admin-aviator-player">
      <h3>{{ player.phone }}</h3>
      <p data-testid="admin-aviator-player-pnl">P/L {{ money(player.netPnlTzs) }} · dau {{ money(player.stakesTzs) }} · malipo {{ money(player.payoutsTzs) }} · {{ player.bets }} dau</p>
      <p v-if="!player.flags.length" class="muted">Hakuna alama.</p>
      <p v-for="flag in player.flags" :key="flag.code" class="aviator-flag" data-testid="admin-aviator-flag" :data-flag="flag.code">{{ flag.detail }}</p>
      <button v-if="!player.suspended" type="button" data-testid="admin-aviator-suspend" @click="suspend(player.userId)">Zuia Aviator</button>
      <button v-else type="button" data-testid="admin-aviator-unsuspend" @click="unsuspend(player.userId)">Ruhusu Aviator</button>
      <div class="aviator-admin-scroll">
        <p v-for="row in player.history" :key="row.id" data-testid="admin-aviator-history">
          #{{ row.roundNo }} · {{ money(row.stakeTzs) }} · {{ row.status }}
          <span v-if="row.autoCashout != null"> · auto {{ row.autoCashout.toFixed(2) }}x</span>
          <span v-if="row.multiplier != null"> @ {{ row.multiplier.toFixed(2) }}x</span>
          <span v-if="row.crashPoint != null"> · crash {{ row.crashPoint.toFixed(2) }}x</span>
          → {{ money(row.payoutTzs) }}
        </p>
      </div>
    </div>

    <form v-if="settings" class="card" @submit.prevent="save" data-testid="admin-aviator-settings">
      <h3>Mipangilio (raundi ijayo)</h3>
      <label class="check"><input type="checkbox" v-model="settings.aviatorEnabled" data-testid="admin-aviator-enabled" /> Washa Aviator</label>
      <label>RTP (bps, 9600 = 96%, faida ya nyumba {{ ((10000 - settings.aviatorRtpBps) / 100).toFixed(2) }}%)
        <input type="number" v-model.number="settings.aviatorRtpBps" min="8000" max="9900" step="50" data-testid="admin-aviator-rtp" />
      </label>
      <label>Kizidishi cha juu<input type="number" v-model.number="settings.aviatorMaxMultiplier" min="50" max="100000" data-testid="admin-aviator-max" /></label>
      <label>Dau la chini (TZS)<input type="number" v-model.number="settings.aviatorMinStake" data-testid="admin-aviator-min-stake" /></label>
      <label>Dau la juu (TZS)<input type="number" v-model.number="settings.aviatorMaxStake" data-testid="admin-aviator-max-stake" /></label>
      <label>Ushindi wa juu (TZS)<input type="number" v-model.number="settings.aviatorMaxWin" data-testid="admin-aviator-max-win" /></label>
      <label>Muda wa dau (ms)<input type="number" v-model.number="settings.aviatorBettingMs" data-testid="admin-aviator-betting-ms" /></label>
      <label>Muda baada ya kuanguka (ms)<input type="number" v-model.number="settings.aviatorCrashedMs" data-testid="admin-aviator-crashed-ms" /></label>
      <button type="submit" data-testid="admin-aviator-save">Hifadhi</button>
    </form>

    <section v-if="budget" class="card" data-testid="admin-aviator-budget">
      <h3>Bajeti ya Aviator</h3>
      <p class="muted">{{ budget.enabled ? 'ON: inahesabu dau na malipo na kuonyesha loss rate. Crash point haibadiliki.' : 'OFF: crash point bado inatoka kwenye hash. Kaunta zinaendelea.' }} Inaanza raundi ijayo.</p>
      <label class="check">
        <input :checked="budget.enabled" data-testid="admin-aviator-budget-enabled" type="checkbox" @change="onBudgetToggle" />
        Washa bajeti
      </label>
      <p v-if="live?.roundLimits" data-testid="admin-aviator-budget-round">Raundi hii: bajeti {{ live.roundLimits.budgetEnabled ? 'ON' : 'OFF' }}. Ijayo: {{ budget.enabled ? 'ON' : 'OFF' }}.</p>
      <p data-testid="admin-aviator-loss-rate">Loss rate <b>{{ Math.round(budget.lossRate * 100) }}%</b> · iliyobaki {{ money(budget.budgetRemaining) }}</p>
      <p data-testid="admin-aviator-cap">Kikomo cha malipo (55%) {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
        <b v-if="budget.isPayoutCapReached">Kikomo kimefikiwa</b>
      </p>
      <p class="muted">Kikomo cha 55% ni onyo tu. Hakizuii malipo.</p>
      <form @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
        <label>Bajeti
          <input v-model.number="budgetInput" data-testid="admin-aviator-budget-amount" type="number" min="0" step="1" />
        </label>
        <button type="submit" data-testid="admin-aviator-budget-save">Hifadhi bajeti</button>
        <button type="button" data-testid="admin-aviator-budget-reset" @click="saveBudget({ resetCounters: true })">Rejesha 0</button>
      </form>
    </section>

    <h3>Kumbukumbu</h3>
    <form class="aviator-log-search" @submit.prevent="searchLog">
      <input v-model="logQ" data-testid="admin-aviator-log-q" placeholder="simu, raundi, au kitendo" />
      <select v-model="logKind" data-testid="admin-aviator-log-kind">
        <option value="">Yote</option>
        <option value="round">Raundi</option>
        <option value="bet">Dau</option>
        <option value="admin">Admin</option>
      </select>
      <button type="submit" data-testid="admin-aviator-log-search">Tafuta</button>
      <button type="button" data-testid="admin-aviator-export" @click="exportLog">Pakua CSV</button>
    </form>
    <p v-if="!logRows.length" class="muted">Hakuna matukio.</p>
    <div v-for="(row, index) in logRows" :key="`${row.kind}-${row.at}-${index}`" class="admin-row" data-testid="admin-aviator-log" :data-kind="row.kind">
      <span>{{ row.summary }}</span>
      <code v-if="row.serverSeedHash">{{ row.serverSeedHash.slice(0, 12) }}…</code>
      <span v-if="row.serverSeed">seed {{ row.serverSeed.slice(0, 8) }}…</span>
      <span v-else-if="row.kind === 'round'" class="muted">seed imefichwa</span>
    </div>

    <h3>Historia ya raundi</h3>
    <p v-if="!rounds.length" class="muted">Hakuna raundi bado.</p>
    <div v-for="round in rounds" :key="round.id" class="admin-row">
      <button type="button" @click="openRound(round.id)">#{{ round.roundNo }} {{ round.status }}</button>
      <span v-if="round.crashPoint != null">{{ round.crashPoint.toFixed(2) }}x</span>
      <span v-else class="muted">seed bado imefichwa</span>
    </div>
    <div v-if="selected" class="card" data-testid="admin-aviator-round">
      <template v-for="round in rounds.filter((item) => item.id === selected)" :key="round.id">
        <p>Hash: <code>{{ round.serverSeedHash }}</code></p>
        <p v-if="round.serverSeed">Seed: <code>{{ round.serverSeed }}</code></p>
        <p>Client {{ round.clientSeed }} · nonce {{ round.nonce }} · RTP {{ (round.rtpBps / 100).toFixed(2) }}%</p>
      </template>
      <p v-if="!bets.length" class="muted">Hakuna dau.</p>
      <p v-for="bet in bets" :key="bet.id">{{ bet.phone }} · paneli {{ bet.panel }} · {{ money(bet.stakeTzs) }} · {{ bet.status }} <span v-if="bet.multiplier">@ {{ bet.multiplier.toFixed(2) }}x → {{ money(bet.payoutTzs) }}</span></p>
    </div>

    <h3>Mazungumzo</h3>
    <label>Nyamazisha (dakika)<input type="number" v-model.number="minutes" min="1" max="10080" data-testid="admin-aviator-minutes" /></label>
    <div v-for="line in chat" :key="line.id" class="admin-row" data-testid="admin-aviator-chat">
      <span :class="{ muted: line.deleted }">{{ line.phone }}: {{ line.body }}</span>
      <button v-if="!line.deleted" type="button" @click="removeChat(line.id)">Futa</button>
      <button type="button" @click="mute(line.userId)">Nyamazisha</button>
      <button type="button" @click="unmute(line.userId)">Ruhusu</button>
    </div>
  </div>
</template>
