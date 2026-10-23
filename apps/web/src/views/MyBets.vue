<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '../api'
import { fmt } from '../data/mock'
import { useAuth } from '../stores/store'

type Leg = { match: string; market: string; selection: string; odds: number; status: string }
type Bet = {
  id: string
  stakeTzs: number
  combinedOdds: number
  potentialPayoutTzs: number
  status: string
  placedAt: string
  legs: Leg[]
}

const auth = useAuth()
const tab = ref<'open' | 'won' | 'lost' | 'void'>('open')
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
  </div>
  <p v-if="!auth.user"><RouterLink to="/login">{{ $t('login') }}</RouterLink></p>
  <p v-else-if="error">{{ $t('errGeneric') }}</p>
  <div class="card" v-for="bet in bets" :key="bet.id" data-testid="my-bet">
    <b>{{ bet.status }}</b> · {{ $t('stake') }} {{ fmt(bet.stakeTzs) }} @ {{ bet.combinedOdds.toFixed(2) }}
    → {{ $t('potential') }} {{ fmt(bet.potentialPayoutTzs) }}
    <div v-for="(leg, i) in bet.legs" :key="i">{{ leg.match }} · {{ leg.market }} {{ leg.selection }} @ {{ leg.odds.toFixed(2) }} · {{ leg.status }}</div>
  </div>
  <p v-if="auth.user && !bets.length && !error">{{ $t('noBets') }}</p>
</template>
