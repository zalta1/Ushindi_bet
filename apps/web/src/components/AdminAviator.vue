<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ApiClientError, api } from '../api'

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
type Live = { enabled: boolean, phase: string, multiplier: number, countdownMs: number, viewerCount: number, openStakeTzs: number, betCount: number, round: { roundNo: number } | null }
type Pnl = { dayStakes: number, dayPayouts: number, dayProfit: number, allStakes: number, allPayouts: number, allProfit: number, allBets: number, rounds: number }
type Bet = { id: string, phone: string, panel: number, stakeTzs: number, payoutTzs: number, status: string, multiplier: number | null }

const settings = ref<Settings | null>(null)
const live = ref<Live | null>(null)
const pnl = ref<Pnl | null>(null)
const rounds = ref<Round[]>([])
const chat = ref<Chat[]>([])
const bets = ref<Bet[]>([])
const selected = ref('')
const error = ref('')
const status = ref('')
const minutes = ref(10)
let timer: ReturnType<typeof setInterval> | undefined

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString('sw-TZ')}`

async function load() {
  const data = await api<{ live: Live, settings: Settings, pnl: Pnl, rounds: Round[], chat: Chat[] }>('/api/admin/aviator')
  live.value = data.live
  if (!settings.value) settings.value = { ...data.settings }
  pnl.value = data.pnl
  rounds.value = data.rounds
  chat.value = data.chat
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

async function openRound(id: string) {
  selected.value = id
  const data = await api<{ bets: Bet[] }>(`/api/admin/aviator/rounds/${id}`)
  bets.value = data.bets
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

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'error' }
  timer = setInterval(() => { void load().catch(() => undefined) }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div data-testid="admin-aviator">
    <p v-if="error" class="form-error">{{ error }}</p>
    <p v-if="status === 'saved'" data-testid="admin-aviator-saved">Imehifadhiwa</p>
    <p class="muted">Hakuna manipulation per-round. RTP na kilele cha kizidishi vinaathiri raundi ijayo tu. Bajeti haibadilishi crash.</p>

    <div class="admin-stats" v-if="pnl" data-testid="admin-aviator-pnl">
      <article><b>{{ money(pnl.dayProfit) }}</b><span>Faida masaa 24</span></article>
      <article><b>{{ money(pnl.dayStakes) }}</b><span>Dau 24h</span></article>
      <article><b>{{ money(pnl.dayPayouts) }}</b><span>Malipo 24h</span></article>
      <article><b>{{ money(pnl.allProfit) }}</b><span>Faida yote</span></article>
    </div>

    <div class="card" v-if="live" data-testid="admin-aviator-live">
      <h3>Raundi ya sasa</h3>
      <p>
        {{ live.phase }}
        <template v-if="live.round"> · #{{ live.round.roundNo }}</template>
        · {{ live.multiplier.toFixed(2) }}x
        · dau {{ live.betCount }} ({{ money(live.openStakeTzs) }})
        · watazamaji {{ live.viewerCount }}
        <template v-if="live.phase === 'betting'"> · {{ Math.ceil(live.countdownMs / 1000) }}s</template>
      </p>
      <p class="muted">{{ live.enabled ? 'Mchezo upo hai' : 'Mchezo umezimwa' }}</p>
    </div>

    <form v-if="settings" class="card" @submit.prevent="save" data-testid="admin-aviator-settings">
      <h3>Mipangilio</h3>
      <label class="check"><input type="checkbox" v-model="settings.aviatorEnabled" data-testid="admin-aviator-enabled" /> Washa Aviator</label>
      <label>RTP (bps, 9600 = 96%, faida ya nyumba {{ ((10000 - settings.aviatorRtpBps) / 100).toFixed(2) }}%)
        <input type="number" v-model.number="settings.aviatorRtpBps" min="8000" max="9900" step="50" data-testid="admin-aviator-rtp" />
      </label>
      <label>Kizidishi cha juu<input type="number" v-model.number="settings.aviatorMaxMultiplier" min="50" max="100000" /></label>
      <label>Dau la chini (TZS)<input type="number" v-model.number="settings.aviatorMinStake" /></label>
      <label>Dau la juu (TZS)<input type="number" v-model.number="settings.aviatorMaxStake" /></label>
      <label>Ushindi wa juu (TZS)<input type="number" v-model.number="settings.aviatorMaxWin" /></label>
      <label>Muda wa dau (ms)<input type="number" v-model.number="settings.aviatorBettingMs" /></label>
      <label>Muda baada ya kuanguka (ms)<input type="number" v-model.number="settings.aviatorCrashedMs" /></label>
      <button type="submit" data-testid="admin-aviator-save">Hifadhi</button>
    </form>

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
