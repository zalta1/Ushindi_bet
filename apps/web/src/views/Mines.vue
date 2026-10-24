<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Limits = {
  enabled: boolean
  rtpBps: number
  minStake: number
  maxStake: number
  maxWin: number
  minMines: number
  maxMines: number
  cells: number
  budgetEnabled: boolean
}
type Bet = {
  id: string
  stakeTzs: number
  mineCount: number
  revealed: number[]
  multiplier: number
  payoutTzs: number
  status: 'active' | 'settled' | 'lost'
  mines: number[] | null
  createdAt: string
}

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const limits = ref<Limits | null>(null)
const active = ref<Bet | null>(null)
const last = ref<Bet | null>(null)
const history = ref<Bet[]>([])
const mineCount = ref(3)
const stake = ref(1000)
const error = ref('')
const busy = ref(false)

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`
const shown = computed(() => active.value ?? last.value)
const cells = computed(() => Array.from({ length: limits.value?.cells ?? 25 }, (_, i) => i))

function payoutOf(bet: Bet | null) {
  if (!bet || !limits.value) return 0
  const raw = Math.floor((bet.stakeTzs * Math.round(bet.multiplier * 100)) / 100)
  return Math.min(raw, limits.value.maxWin)
}

function cellClass(index: number) {
  const bet = shown.value
  if (!bet) return 'hidden'
  if (bet.revealed.includes(index) && bet.mines?.includes(index)) return 'mine'
  if (bet.revealed.includes(index)) return 'safe'
  if (bet.status !== 'active' && bet.mines?.includes(index)) return 'mine'
  return 'hidden'
}

function cellLabel(index: number) {
  const kind = cellClass(index)
  if (kind === 'mine') return '✱'
  if (kind === 'safe') return '◆'
  return ''
}

function errorText() {
  const key = `mines.err_${error.value}`
  const text = t(key)
  return text === key ? t('mines.err_generic') : text
}

async function load() {
  const data = await api<{ limits: Limits; active: Bet | null; history: Bet[] }>('/api/mines')
  limits.value = data.limits
  active.value = data.active
  history.value = data.history
  if (data.limits) stake.value = Math.min(Math.max(stake.value, data.limits.minStake), data.limits.maxStake)
}

async function start() {
  error.value = ''
  if (!auth.user) {
    await router.push('/login')
    return
  }
  if (!limits.value?.enabled) {
    error.value = 'game_disabled'
    return
  }
  busy.value = true
  try {
    const result = await api<{ balanceTzs: number; bet: Bet }>('/api/mines/start', {
      method: 'POST',
      json: { mineCount: Number(mineCount.value), stakeTzs: Number(stake.value), idempotencyKey: crypto.randomUUID() },
    })
    active.value = result.bet
    last.value = null
    if (auth.user) auth.user.balanceTzs = result.balanceTzs
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    busy.value = false
  }
}

async function reveal(index: number) {
  if (!active.value || busy.value || active.value.revealed.includes(index)) return
  error.value = ''
  busy.value = true
  try {
    const result = await api<{ balanceTzs: number; bet: Bet }>('/api/mines/reveal', {
      method: 'POST',
      json: { betId: active.value.id, cell: index, idempotencyKey: crypto.randomUUID() },
    })
    if (auth.user) auth.user.balanceTzs = result.balanceTzs
    if (result.bet.status === 'active') active.value = result.bet
    else {
      active.value = null
      last.value = result.bet
      history.value = [result.bet, ...history.value].slice(0, 20)
    }
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    busy.value = false
  }
}

async function cashout() {
  if (!active.value || busy.value || active.value.revealed.length === 0) return
  error.value = ''
  busy.value = true
  try {
    const result = await api<{ balanceTzs: number; bet: Bet }>('/api/mines/cashout', {
      method: 'POST',
      json: { betId: active.value.id, idempotencyKey: crypto.randomUUID() },
    })
    active.value = null
    last.value = result.bet
    history.value = [result.bet, ...history.value].slice(0, 20)
    if (auth.user) auth.user.balanceTzs = result.balanceTzs
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'generic' }
})
</script>

<template>
  <div data-testid="mines-page" class="mines">
    <h2>{{ $t('mines.title') }}</h2>
    <p class="muted" data-testid="mines-fairness">{{ limits?.budgetEnabled ? $t('mines.house') : $t('mines.fair') }}</p>
    <p v-if="!limits?.enabled" class="form-error">{{ $t('mines.err_game_disabled') }}</p>
    <p v-if="error" class="form-error" data-testid="mines-error">{{ errorText() }}</p>

    <section class="mines-board card">
      <p v-if="shown" data-testid="mines-multiplier">{{ $t('mines.multiplier') }} <b>{{ shown.multiplier.toFixed(2) }}x</b></p>
      <p v-if="last && !active" data-testid="mines-result" :class="last.status === 'lost' ? 'loss' : 'win'">
        {{ last.status === 'lost' ? $t('mines.loss') : $t('mines.win') }} · {{ money(last.payoutTzs) }}
      </p>
      <p v-else-if="!active" class="muted">{{ $t('mines.prompt') }}</p>

      <div v-if="shown" class="mines-grid" data-testid="mines-grid">
        <button
          v-for="index in cells"
          :key="index"
          type="button"
          class="mines-cell"
          :class="cellClass(index)"
          :data-testid="`mines-cell-${index}`"
          :disabled="!active || busy || active.revealed.includes(index)"
          @click="reveal(index)"
        >{{ cellLabel(index) }}</button>
      </div>

      <template v-if="active">
        <button type="button" class="deposit-btn" data-testid="mines-cashout" :disabled="busy || active.revealed.length === 0" @click="cashout">
          {{ $t('mines.cashout') }} {{ money(payoutOf(active)) }}
        </button>
      </template>
      <template v-else>
        <label>{{ $t('mines.count') }} <b>{{ mineCount }}</b>
          <input v-model.number="mineCount" data-testid="mines-count" type="range" :min="limits?.minMines ?? 1" :max="limits?.maxMines ?? 24" step="1" />
        </label>
        <label>{{ $t('mines.stake') }}
          <input v-model.number="stake" data-testid="mines-stake" type="number" :min="limits?.minStake ?? 100" :max="limits?.maxStake ?? 2000000" step="1" />
        </label>
        <button type="button" class="deposit-btn" data-testid="mines-start" :disabled="busy || !limits?.enabled" @click="start">
          {{ busy ? $t('mines.starting') : auth.user ? $t('mines.start') : $t('mines.login') }}
        </button>
      </template>
    </section>

    <section data-testid="mines-history">
      <h3>{{ $t('mines.history') }}</h3>
      <p v-if="!history.length" class="muted">{{ $t('mines.noHistory') }}</p>
      <p v-for="bet in history" :key="bet.id" data-testid="mines-history-row">
        {{ bet.mineCount }} {{ $t('mines.count') }} · {{ bet.revealed.length }} · {{ bet.multiplier.toFixed(2) }}x · {{ money(bet.stakeTzs) }} → {{ money(bet.payoutTzs) }} · {{ bet.status === 'lost' ? $t('mines.loss') : $t('mines.win') }}
      </p>
    </section>
  </div>
</template>
