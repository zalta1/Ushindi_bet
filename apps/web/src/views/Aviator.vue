<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import plane from '../assets/hero-planes.png'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Mine = {
  id: string
  panel: number
  stakeTzs: number
  payoutTzs: number
  status: string
  multiplier: number | null
  autoCashout: number | null
}
type Person = {
  id: string
  panel?: number
  stakeTzs: number
  payoutTzs: number
  status: string
  multiplier: number | null
  phone: string
  initials: string
  color: string
  body?: string
  createdAt?: string
}
type Snap = {
  enabled: boolean
  phase: string
  multiplier: number
  countdownMs: number
  round: { id: string, roundNo: number, serverSeedHash: string } | null
  history: { id: string, roundNo: number, crashPoint: number }[]
  liveBets: Person[]
  winners: Person[]
  chat: Person[]
  viewerCount: number
  myBets: Mine[]
  limits: { aviatorMinStake: number, aviatorMaxStake: number, aviatorMaxWin: number, aviatorRtpBps: number }
}

const auth = useAuth()
const { t } = useI18n()
const snap = ref<Snap | null>(null)
const error = ref('')
const tab = ref<'bets' | 'winners' | 'chat'>('bets')
const stake = ref([1000, 1000])
const autoOn = ref([false, false])
const autoAt = ref([2, 2])
const chatBody = ref('')
const busy = ref(false)
let source: EventSource | null = null
let poll: ReturnType<typeof setInterval> | undefined
let viewers: ReturnType<typeof setInterval> | undefined

function apply(data: Snap) {
  snap.value = data
}

async function load() {
  try {
    apply(await api<Snap>('/api/aviator/state'))
  } catch {
    // Keep the last frame if a poll fails.
  }
}

function listen() {
  if (typeof EventSource === 'undefined') {
    poll = setInterval(() => { void load() }, 400)
    return
  }
  source = new EventSource('/api/aviator/stream')
  source.onmessage = (ev) => {
    try { apply(JSON.parse(ev.data) as Snap) } catch { /* ignore a bad frame */ }
  }
  source.onerror = () => {
    source?.close()
    source = null
    if (!poll) poll = setInterval(() => { void load() }, 400)
  }
}

onMounted(() => {
  void load()
  listen()
  const existing = sessionStorage.getItem('aviator-session')
  const sessionId = existing && existing.length >= 8 ? existing : crypto.randomUUID()
  sessionStorage.setItem('aviator-session', sessionId)
  const ping = () => {
    if (!auth.user) return
    void api('/api/aviator/viewers', { method: 'POST', json: { sessionId } }).catch(() => undefined)
  }
  ping()
  viewers = setInterval(ping, 10_000)
})

onUnmounted(() => {
  source?.close()
  if (poll) clearInterval(poll)
  if (viewers) clearInterval(viewers)
})

function mine(panel: number) {
  return snap.value?.myBets.find((bet) => bet.panel === panel)
}

function explain(err: unknown) {
  if (!(err instanceof ApiClientError)) return t('aviator.errGeneric')
  const key = `aviator.err_${err.code}`
  const text = t(key)
  return text === key ? t('aviator.errGeneric') : text
}

async function place(panel: number) {
  error.value = ''
  busy.value = true
  try {
    const res = await api<{ balanceTzs: number }>('/api/aviator/bets', {
      method: 'POST',
      json: {
        stakeTzs: stake.value[panel - 1],
        panel,
        autoCashout: autoOn.value[panel - 1] ? autoAt.value[panel - 1] : null,
        idempotencyKey: `av-stake-${crypto.randomUUID()}`,
      },
    })
    if (auth.user) auth.user.balanceTzs = res.balanceTzs
    await load()
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function cashOut(betId: string) {
  error.value = ''
  busy.value = true
  try {
    const res = await api<{ balanceTzs: number }>('/api/aviator/cashout', { method: 'POST', json: { betId } })
    if (auth.user) auth.user.balanceTzs = res.balanceTzs
    await load()
  } catch (err) {
    error.value = explain(err)
    await load()
  } finally {
    busy.value = false
  }
}

async function sendChat() {
  error.value = ''
  const body = chatBody.value.trim()
  if (!body) return
  try {
    await api('/api/aviator/chat', { method: 'POST', json: { body } })
    chatBody.value = ''
    await load()
  } catch (err) {
    error.value = explain(err)
  }
}

function pill(mult: number) {
  if (mult >= 10) return 'av-pill purple'
  if (mult >= 5) return 'av-pill pink'
  if (mult >= 2) return 'av-pill green'
  return 'av-pill blue'
}

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString('sw-TZ')}`

const planeStyle = computed(() => {
  const phase = snap.value?.phase
  const mult = snap.value?.multiplier ?? 1
  const progress = phase === 'flying' || phase === 'crashed'
    ? Math.min(1, Math.log(Math.max(mult, 1)) / Math.log(12))
    : 0.05
  return {
    left: `${8 + progress * 52}%`,
    top: `${64 - progress * 46}%`,
    transform: `rotate(${-6 - progress * 16}deg)`,
    opacity: phase === 'crashed' ? '0.45' : '1',
  }
})

const headline = computed(() => {
  const phase = snap.value?.phase
  if (!snap.value?.enabled && phase !== 'flying') return t('aviator.disabled')
  if (phase === 'betting') return `${Math.max(1, Math.ceil((snap.value?.countdownMs ?? 0) / 1000))}`
  if (phase === 'crashed') return t('aviator.flewAway')
  if (phase === 'flying') return `${(snap.value?.multiplier ?? 1).toFixed(2)}x`
  return t('aviator.wait')
})
</script>

<template>
  <div class="aviator" data-testid="aviator-game">
    <div class="av-main">
      <div class="av-history" data-testid="aviator-history">
        <RouterLink
          v-for="item in snap?.history ?? []"
          :key="item.id"
          :class="pill(item.crashPoint)"
          :to="`/aviator/fair?round=${item.id}`"
        >{{ item.crashPoint.toFixed(2) }}x</RouterLink>
        <span v-if="!snap?.history.length" class="muted">{{ $t('aviator.noHistory') }}</span>
      </div>

      <div class="av-sky" :class="snap?.phase">
        <img class="av-plane" :src="plane" alt="" data-testid="aviator-plane" :style="planeStyle" />
        <div class="av-readout">
          <p class="av-phase">{{ snap?.phase === 'betting' ? $t('aviator.betting') : (snap?.phase === 'flying' ? $t('aviator.flying') : '') }}</p>
          <h1 data-testid="aviator-multiplier" :class="{ crash: snap?.phase === 'crashed' }">{{ headline }}</h1>
          <p v-if="snap?.phase === 'crashed'" class="av-crash">{{ (snap?.multiplier ?? 1).toFixed(2) }}x</p>
          <p class="av-meta">{{ $t('aviator.viewers', { n: snap?.viewerCount ?? 0 }) }} · RTP {{ ((snap?.limits.aviatorRtpBps ?? 9600) / 100).toFixed(2) }}%</p>
        </div>
      </div>

      <p v-if="error" class="form-error" data-testid="aviator-error">{{ error }}</p>
      <p v-if="snap && !snap.enabled" class="muted">{{ $t('aviator.disabled') }}</p>

      <div class="av-panels">
        <form v-for="panel in [1, 2]" :key="panel" class="av-panel" @submit.prevent="mine(panel)?.status === 'active' && snap?.phase === 'flying' ? cashOut(mine(panel)!.id) : place(panel)">
          <div class="av-panel-head">
            <b>{{ $t('aviator.panel', { n: panel }) }}</b>
            <span v-if="mine(panel)?.status === 'cashed_out'">{{ mine(panel)!.multiplier?.toFixed(2) }}x</span>
          </div>
          <label>{{ $t('aviator.stake') }}
            <input type="number" v-model.number="stake[panel - 1]" :min="snap?.limits.aviatorMinStake ?? 100" :max="snap?.limits.aviatorMaxStake ?? 2000000" :data-testid="`aviator-stake-${panel}`" />
          </label>
          <label class="check">
            <input type="checkbox" v-model="autoOn[panel - 1]" :data-testid="`aviator-auto-${panel}`" />
            {{ $t('aviator.auto') }}
          </label>
          <label v-if="autoOn[panel - 1]">{{ $t('aviator.autoAt') }}
            <input type="number" step="0.01" min="1.01" v-model.number="autoAt[panel - 1]" :data-testid="`aviator-auto-at-${panel}`" />
          </label>
          <button
            v-if="!auth.user"
            type="button"
            @click="$router.push('/login')"
          >{{ $t('aviator.login') }}</button>
          <button
            v-else-if="mine(panel)?.status === 'active' && snap?.phase === 'flying'"
            type="submit"
            class="av-cash"
            :disabled="busy"
            :data-testid="`aviator-cashout-${panel}`"
          >{{ $t('aviator.cashout') }} {{ money(Math.min(Math.floor(mine(panel)!.stakeTzs * (snap?.multiplier ?? 1)), snap?.limits.aviatorMaxWin ?? mine(panel)!.stakeTzs)) }}</button>
          <button
            v-else-if="mine(panel)?.status === 'cashed_out'"
            type="button"
            disabled
          >{{ $t('aviator.cashed', { n: mine(panel)!.multiplier?.toFixed(2) }) }}</button>
          <button
            v-else
            type="submit"
            class="av-bet"
            :disabled="busy || snap?.phase !== 'betting' || !snap?.enabled"
            :data-testid="`aviator-bet-${panel}`"
          >{{ $t('aviator.bet') }}</button>
          <small class="muted">{{ $t('aviator.limits', { min: snap?.limits.aviatorMinStake ?? 100, max: snap?.limits.aviatorMaxStake ?? 2000000, win: snap?.limits.aviatorMaxWin ?? 0 }) }}</small>
        </form>
      </div>
      <RouterLink class="av-fair-link" to="/aviator/fair" data-testid="aviator-fair-link">{{ $t('aviator.fairLink') }}</RouterLink>
    </div>

    <aside class="av-side">
      <div class="chips">
        <button type="button" :class="{ active: tab === 'bets' }" @click="tab = 'bets'" data-testid="aviator-tab-bets">{{ $t('aviator.bets') }}</button>
        <button type="button" :class="{ active: tab === 'winners' }" @click="tab = 'winners'" data-testid="aviator-tab-winners">{{ $t('aviator.winners') }}</button>
        <button type="button" :class="{ active: tab === 'chat' }" @click="tab = 'chat'" data-testid="aviator-tab-chat">{{ $t('aviator.chat') }}</button>
      </div>

      <div v-if="tab === 'bets'" data-testid="aviator-live-bets">
        <p v-if="!snap?.liveBets.length" class="muted">{{ $t('aviator.emptyBets') }}</p>
        <div v-for="bet in snap?.liveBets ?? []" :key="bet.id" class="av-row">
          <span class="av-avatar" :style="{ background: bet.color }">{{ bet.initials }}</span>
          <span>{{ bet.phone }}</span>
          <b>{{ money(bet.stakeTzs) }}</b>
          <span v-if="bet.multiplier">{{ bet.multiplier.toFixed(2) }}x</span>
          <span v-else class="muted">{{ bet.status }}</span>
        </div>
      </div>

      <div v-else-if="tab === 'winners'" data-testid="aviator-winners">
        <p class="muted">{{ $t('aviator.topWinners') }}</p>
        <p v-if="!snap?.winners.length" class="muted">{{ $t('aviator.emptyBets') }}</p>
        <div v-for="bet in snap?.winners ?? []" :key="bet.id" class="av-row">
          <span class="av-avatar" :style="{ background: bet.color }">{{ bet.initials }}</span>
          <span>{{ bet.phone }}</span>
          <b class="gold">{{ money(bet.payoutTzs) }}</b>
          <span>{{ bet.multiplier?.toFixed(2) }}x</span>
        </div>
      </div>

      <div v-else data-testid="aviator-chat">
        <div class="av-chat">
          <p v-if="!snap?.chat.length" class="muted">{{ $t('aviator.emptyChat') }}</p>
          <p v-for="line in snap?.chat ?? []" :key="line.id" class="av-msg">
            <span class="av-avatar" :style="{ background: line.color }">{{ line.initials }}</span>
            <span><b>{{ line.phone }}</b> {{ line.body }}</span>
          </p>
        </div>
        <form v-if="auth.user" @submit.prevent="sendChat" class="av-chat-form">
          <input v-model="chatBody" maxlength="200" :placeholder="$t('aviator.chatPlaceholder')" data-testid="aviator-chat-input" />
          <button type="submit" data-testid="aviator-chat-send">{{ $t('aviator.send') }}</button>
        </form>
        <p v-else class="muted">{{ $t('aviator.login') }}</p>
      </div>
    </aside>
  </div>
</template>
