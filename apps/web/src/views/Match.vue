<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { fmtTime } from '../data/mock'
import { useSlip } from '../stores/store'

type Outcome = { sel: string; price: number; oddsId: number; market: string; suspended?: boolean }
type MatchRow = {
  id: number
  home: string
  away: string
  league: string
  country: string
  kickoff: string
  live: boolean
  minute: number
  hs: number
  as: number
  status: string
  markets: Record<string, Outcome[]>
}

const route = useRoute()
const slip = useSlip()
const match = ref<MatchRow | null>(null)
const missing = ref(false)
const tab = ref('1X2')
const labels: Record<string, string> = {
  '1X2': '1X2 | Full Time',
  BTTS: 'Both Teams To Score | Full Time',
  'Over/Under': 'Over/Under | Full Time',
  'Double Chance': 'Double Chance | Full Time',
}

async function load() {
  missing.value = false
  match.value = null
  try {
    match.value = await api<MatchRow>(`/api/matches/${route.params.id}`)
    const keys = Object.keys(match.value.markets || {})
    if (!keys.includes(tab.value)) tab.value = keys[0] || '1X2'
  } catch {
    missing.value = true
  }
}

onMounted(load)
watch(() => route.params.id, load)
</script>
<template>
  <p v-if="missing">{{ $t('noMatches') }}</p>
  <div v-else-if="match" data-testid="match-page">
    <h2>{{ match.home }} vs {{ match.away }}</h2>
    <p>{{ match.league }} · {{ match.country }} · {{ fmtTime(match.kickoff) }}
      <span v-if="match.live" class="live">LIVE {{ match.minute }}' {{ match.hs }}-{{ match.as }}</span>
      <span v-else-if="match.status === 'finished' || match.status === 'void'">{{ match.hs }}-{{ match.as }} · {{ match.status }}</span>
    </p>
    <div class="chips">
      <button v-for="name in Object.keys(match.markets)" :key="name" type="button" :class="{ active: tab === name }" @click="tab = name">{{ labels[name] || name }}</button>
    </div>
    <div class="odds">
      <button
        v-for="outcome in match.markets[tab] || []"
        :key="outcome.oddsId"
        type="button"
        :disabled="outcome.suspended || match.status === 'finished' || match.status === 'void'"
        @click="slip.toggle(match, outcome)"
      >{{ outcome.sel }}<b>{{ outcome.price.toFixed(2) }}</b></button>
    </div>
  </div>
</template>
