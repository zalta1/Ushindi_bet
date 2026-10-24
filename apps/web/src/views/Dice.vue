<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Limits = { enabled: boolean; rtpBps: number; minStake: number; maxStake: number; maxWin: number; minTarget: number; maxTarget: number }
type Commitment = { serverSeedHash: string; clientSeed: string; nonce: number }
type Bet = {
  id: string
  stakeTzs: number
  target: number
  side: 'under' | 'over'
  roll: number
  multiplier: number
  payoutTzs: number
  won: boolean
  serverSeed: string
  serverSeedHash: string
  clientSeed: string
  nonce: number
  createdAt: string
}

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const limits = ref<Limits | null>(null)
const commitment = ref<Commitment | null>(null)
const history = ref<Bet[]>([])
const side = ref<'under' | 'over'>('under')
const target = ref(50)
const stake = ref(1000)
const last = ref<Bet | null>(null)
const error = ref('')
const playing = ref(false)

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

function price(nextTarget: number, nextSide: 'under' | 'over', rtpBps: number) {
  const window = nextSide === 'under' ? nextTarget : 100 - nextTarget
  if (window <= 0) return 0
  return Number(((99 / window) * (rtpBps / 10000)).toFixed(2))
}

const multiplier = computed(() => (limits.value ? price(target.value, side.value, limits.value.rtpBps) : 0))
const payout = computed(() => {
  if (!limits.value || multiplier.value < 1.01) return 0
  const raw = Math.floor((Number(stake.value) * Math.round(multiplier.value * 100)) / 100)
  return Math.min(raw, limits.value.maxWin)
})

function errorText() {
  const key = `dice.err_${error.value}`
  const text = t(key)
  return text === key ? t('dice.err_generic') : text
}

async function load() {
  const data = await api<{ limits: Limits; commitment: Commitment | null; history: Bet[] }>('/api/dice')
  limits.value = data.limits
  commitment.value = data.commitment
  history.value = data.history
  if (data.limits) {
    stake.value = Math.min(Math.max(stake.value, data.limits.minStake), data.limits.maxStake)
  }
}

async function play() {
  error.value = ''
  if (!auth.user) {
    await router.push('/login')
    return
  }
  if (!limits.value?.enabled) {
    error.value = 'game_disabled'
    return
  }
  if (multiplier.value < 1.01) {
    error.value = 'validation'
    return
  }
  playing.value = true
  try {
    const result = await api<{ balanceTzs: number; bet: Bet; next: Commitment | null }>('/api/dice/play', {
      method: 'POST',
      json: { side: side.value, target: target.value, stakeTzs: Number(stake.value), idempotencyKey: crypto.randomUUID() },
    })
    last.value = result.bet
    if (auth.user) auth.user.balanceTzs = result.balanceTzs
    if (result.next) commitment.value = result.next
    history.value = [result.bet, ...history.value].slice(0, 20)
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    playing.value = false
  }
}

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'generic' }
})
</script>

<template>
  <div data-testid="dice-page" class="dice">
    <h2>{{ $t('dice.title') }}</h2>
    <p class="muted">{{ $t('dice.fair') }}</p>
    <p v-if="commitment" class="dice-hash" data-testid="dice-hash">{{ $t('dice.hash') }} <code>{{ commitment.serverSeedHash }}</code> · nonce {{ commitment.nonce }}</p>
    <p v-if="!limits?.enabled" class="form-error">{{ $t('dice.err_game_disabled') }}</p>
    <p v-if="error" class="form-error" data-testid="dice-error">{{ errorText() }}</p>

    <section class="dice-board card">
      <p class="dice-roll" data-testid="dice-roll" :class="{ win: last?.won, loss: last && !last.won }">{{ last ? last.roll : '–' }}</p>
      <p v-if="last" data-testid="dice-result">{{ last.won ? $t('dice.win') : $t('dice.loss') }} · {{ money(last.payoutTzs) }}</p>
      <p v-else class="muted">{{ $t('dice.prompt') }}</p>
      <div class="chips">
        <button type="button" data-testid="dice-side-under" :class="{ on: side === 'under' }" @click="side = 'under'">{{ $t('dice.under') }}</button>
        <button type="button" data-testid="dice-side-over" :class="{ on: side === 'over' }" @click="side = 'over'">{{ $t('dice.over') }}</button>
      </div>
      <label>{{ $t('dice.target') }} <b>{{ target }}</b>
        <input v-model.number="target" data-testid="dice-target" type="range" :min="limits?.minTarget ?? 2" :max="limits?.maxTarget ?? 98" step="1" />
      </label>
      <label>{{ $t('dice.stake') }}
        <input v-model.number="stake" data-testid="dice-stake" type="number" :min="limits?.minStake ?? 100" :max="limits?.maxStake ?? 2000000" step="1" />
      </label>
      <p data-testid="dice-multiplier">{{ $t('dice.multiplier') }} <b>{{ multiplier.toFixed(2) }}x</b> · {{ $t('dice.potential') }} {{ money(payout) }}</p>
      <p class="muted">{{ $t('dice.rule', { target, side: side === 'under' ? $t('dice.under') : $t('dice.over') }) }}</p>
      <button type="button" class="deposit-btn" data-testid="dice-play" :disabled="playing || !limits?.enabled" @click="play">
        {{ playing ? $t('dice.rolling') : auth.user ? $t('dice.play') : $t('dice.login') }}
      </button>
      <p v-if="last" class="muted dice-reveal" data-testid="dice-reveal">{{ $t('dice.seed') }} <code>{{ last.serverSeed }}</code></p>
    </section>

    <section data-testid="dice-history">
      <h3>{{ $t('dice.history') }}</h3>
      <p v-if="!history.length" class="muted">{{ $t('dice.noHistory') }}</p>
      <p v-for="bet in history" :key="bet.id" data-testid="dice-history-row">
        {{ bet.roll }} · {{ bet.side === 'under' ? $t('dice.under') : $t('dice.over') }} {{ bet.target }} · {{ bet.multiplier.toFixed(2) }}x · {{ money(bet.stakeTzs) }} → {{ money(bet.payoutTzs) }} · {{ bet.won ? $t('dice.win') : $t('dice.loss') }}
      </p>
    </section>
  </div>
</template>
