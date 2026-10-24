<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { fmtTime } from '../data/mock'
import { useSlip } from '../stores/store'

type Outcome = { sel: string; price: number; oddsId: number; market: string; suspended?: boolean }
type DetailEvent = { minute: number; team: string; type: string; detail: string; player: string }
type LastRow = { date: string; opponent: string; hs: number; as: number }
type Details = {
  source: string
  note: string
  events: DetailEvent[]
  lineups: { homeFormation: string; awayFormation: string; home: string[]; away: string[] }
  h2h: { date: string; home: string; away: string; hs: number; as: number }[]
  injuries: { team: string; player: string; reason: string }[]
  last: { home: LastRow[]; away: LastRow[] }
  stats: { homePossession: number | null; awayPossession: number | null }
}
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
  hot: boolean
  markets: Record<string, Outcome[]>
  details: Details
}

const route = useRoute()
const slip = useSlip()
const match = ref<MatchRow | null>(null)
const missing = ref(false)
const tab = ref('1X2')
const labels: Record<string, string> = {
  '1X2': '1X2 | Full Time',
  '2UP': '2UP | Full Time',
  BTTS: 'Both Teams To Score | Full Time',
  'Over/Under': 'Over/Under | Full Time',
  'Double Chance': 'Double Chance | Full Time',
  'Correct Score': 'Correct Score | Full Time',
  'Draw No Bet': 'Draw No Bet | Full Time',
  'Odd/Even': 'Odd/Even | Full Time',
  'Home/Away': 'Home/Away | Full Time',
  'Exact Goals': 'Exact Goals | Full Time',
}

function label(name: string) {
  if (labels[name]) return labels[name]
  if (name.startsWith('3-Way Handicap')) return `${name} | Full Time`
  if (name.startsWith('2-Way Handicap')) return `${name} | Full Time`
  return name
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
    <p class="muted">{{ match.league }} · {{ match.country }}</p>
    <h2>
      <span v-if="match.hot" class="hot-badge">HOT</span>
      {{ match.home }} vs {{ match.away }}
    </h2>
    <p>{{ fmtTime(match.kickoff) }}
      <span v-if="match.live" class="live">LIVE {{ match.minute }}' {{ match.hs }}-{{ match.as }}</span>
      <span v-else-if="match.status === 'finished' || match.status === 'void'">{{ match.hs }}-{{ match.as }} · {{ match.status }}</span>
    </p>

    <div class="card" data-testid="match-tracker">
      <b>{{ $t('matchTracker') }}</b>
      <p class="tracker-score">{{ match.hs }} - {{ match.as }}</p>
      <div class="tracker-bar" v-if="match.details?.stats?.homePossession != null">
        <span :style="{ width: `${match.details.stats.homePossession}%` }">{{ match.details.stats.homePossession }}%</span>
        <span :style="{ width: `${match.details.stats.awayPossession ?? 0}%` }">{{ match.details.stats.awayPossession }}%</span>
      </div>
      <div v-else class="tracker-bar">
        <span :style="{ width: `${Math.min(100, (match.minute / 90) * 100)}%` }">{{ match.minute }}'</span>
      </div>
    </div>

    <div class="card" data-testid="match-events">
      <b>{{ $t('matchEvents') }}</b>
      <p v-if="!match.details?.events?.length" class="muted">{{ match.details?.note || $t('noDetail') }}</p>
      <p v-for="(event, i) in match.details?.events || []" :key="i">
        {{ event.minute }}' {{ event.team === 'away' ? match.away : match.home }} · {{ event.type }} {{ event.detail }} · {{ event.player }}
      </p>
    </div>

    <div class="card" data-testid="match-lineups">
      <b>{{ $t('matchLineups') }}</b>
      <p v-if="!match.details?.lineups?.home?.length" class="muted">{{ $t('noDetail') }}</p>
      <div v-else class="split">
        <div><b>{{ match.home }}</b> {{ match.details.lineups.homeFormation }}<p v-for="name in match.details.lineups.home" :key="name">{{ name }}</p></div>
        <div><b>{{ match.away }}</b> {{ match.details.lineups.awayFormation }}<p v-for="name in match.details.lineups.away" :key="name">{{ name }}</p></div>
      </div>
    </div>

    <div class="card" data-testid="match-h2h">
      <b>{{ $t('matchH2h') }}</b>
      <p v-if="!match.details?.h2h?.length" class="muted">{{ $t('noDetail') }}</p>
      <p v-for="(row, i) in match.details?.h2h || []" :key="i">{{ row.home }} {{ row.hs }}-{{ row.as }} {{ row.away }}</p>
    </div>

    <div class="card" data-testid="match-injuries">
      <b>{{ $t('matchInjuries') }}</b>
      <p v-if="!match.details?.injuries?.length" class="muted">{{ $t('noDetail') }}</p>
      <p v-for="(row, i) in match.details?.injuries || []" :key="i">{{ row.player }} · {{ row.reason }}</p>
    </div>

    <div class="card" data-testid="match-last">
      <b>{{ $t('matchLast') }}</b>
      <p v-if="!match.details?.last?.home?.length && !match.details?.last?.away?.length" class="muted">{{ $t('noDetail') }}</p>
      <div v-else class="split">
        <div><b>{{ match.home }}</b><p v-for="(row, i) in match.details.last.home" :key="i">{{ row.hs }}-{{ row.as }} {{ row.opponent }}</p></div>
        <div><b>{{ match.away }}</b><p v-for="(row, i) in match.details.last.away" :key="i">{{ row.hs }}-{{ row.as }} {{ row.opponent }}</p></div>
      </div>
    </div>

    <div v-if="match.markets['2UP']" class="card" data-testid="two-up-terms">
      <b>{{ $t('twoUpTitle') }}</b>
      <p>{{ $t('twoUpTerms') }}</p>
    </div>

    <div class="chips">
      <button v-for="name in Object.keys(match.markets)" :key="name" type="button" :class="{ active: tab === name }" @click="tab = name">{{ label(name) }}</button>
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
