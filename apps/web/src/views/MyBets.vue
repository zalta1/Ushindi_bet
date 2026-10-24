<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ApiClientError, api } from '../api'
import { fmt } from '../data/mock'
import { useAuth } from '../stores/store'

type Leg = { match: string; market: string; selection: string; odds: number; status: string }
type Bet = {
  id: string
  stakeTzs: number
  combinedOdds: number
  potentialPayoutTzs: number
  payoutPercentBps: number
  status: string
  placedAt: string
  cashoutTzs: number | null
  legs: Leg[]
}

const auth = useAuth()
const tab = ref<'open' | 'won' | 'lost' | 'void' | 'cashout'>('open')
const bets = ref<Bet[]>([])
const error = ref('')

async function load() {
  error.value = ''
  if (!auth.bootstrapped) await auth.bootstrap()
  if (!auth.user) {
    bets.value = []
    return
  }
  try {
    const data = await api<{ data: Bet[] }>(`/api/bets?status=${tab.value}`)
    bets.value = data.data
  } catch {
    error.value = 'error'
  }
}

async function cashOut(bet: Bet) {
  error.value = ''
  if (bet.cashoutTzs == null) return
  try {
    await api(`/api/bets/${bet.id}/cashout`, { method: 'POST', json: { expectedTzs: bet.cashoutTzs } })
    await auth.loadMe()
    tab.value = 'cashout'
    await load()
  } catch (err) {
    const code = err instanceof ApiClientError ? err.code : ''
    await load()
    error.value = code === 'cashout_changed' ? 'changed' : 'closed'
  }
}

onMounted(load)
watch(tab, load)
</script>
<template>
  <h2>{{ $t('mybets') }}</h2>
  <div class="chips" data-testid="my-bets-tabs">
    <button type="button" :class="{ active: tab === 'open' }" @click="tab = 'open'">{{ $t('betsOpen') }}</button>
    <button type="button" :class="{ active: tab === 'won' }" @click="tab = 'won'">{{ $t('betsWon') }}</button>
    <button type="button" :class="{ active: tab === 'lost' }" @click="tab = 'lost'">{{ $t('betsLost') }}</button>
    <button type="button" :class="{ active: tab === 'void' }" @click="tab = 'void'">{{ $t('betsVoid') }}</button>
    <button type="button" :class="{ active: tab === 'cashout' }" @click="tab = 'cashout'">{{ $t('betsCashout') }}</button>
  </div>
  <p v-if="!auth.user"><RouterLink to="/login">{{ $t('login') }}</RouterLink></p>
  <p v-else-if="error === 'changed'" data-testid="cashout-error">{{ $t('errCashout') }}</p>
  <p v-else-if="error === 'closed'" data-testid="cashout-error">{{ $t('errCashoutClosed') }}</p>
  <p v-else-if="error">{{ $t('errGeneric') }}</p>
  <div class="card" v-for="bet in bets" :key="bet.id" data-testid="my-bet">
    <b>{{ bet.status }}</b> · {{ $t('stake') }} {{ fmt(bet.stakeTzs) }} @ {{ bet.combinedOdds.toFixed(2) }}
    → {{ $t('potential') }} <b data-testid="bet-payout">{{ fmt(bet.potentialPayoutTzs) }}</b>
    <span v-if="bet.payoutPercentBps < 10000" class="muted"> · {{ $t('payoutRate', { n: (bet.payoutPercentBps / 100).toFixed(0) }) }}</span>
    <div v-for="(leg, i) in bet.legs" :key="i">{{ leg.match }} · {{ leg.market }} {{ leg.selection }} @ {{ leg.odds.toFixed(2) }} · {{ leg.status }}</div>
    <button v-if="tab === 'open' && bet.cashoutTzs" type="button" data-testid="cashout-button" @click="cashOut(bet)">{{ $t('cashout', { n: fmt(bet.cashoutTzs) }) }}</button>
    <p v-else-if="tab === 'open'" class="muted">{{ $t('cashoutNone') }}</p>
  </div>
  <p v-if="auth.user && !bets.length && !error">{{ $t('noBets') }}</p>
</template>
