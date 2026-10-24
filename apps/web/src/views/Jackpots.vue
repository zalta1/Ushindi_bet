<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Match = {
  position: number
  home: string
  away: string
  league: string
  kickoff: string
  status: string
  homeScore: number
  awayScore: number
  result: string | null
  odds: { home: number | null; draw: number | null; away: number | null }
}

type Jackpot = {
  id: string
  type: string
  name: string
  stakeTzs: number
  grandPrizeTzs: number
  tierPrizes: Record<string, number>
  closingTime: string
  prizePoolTzs: number
  participants: number
  totalMatches: number
  matches: Match[]
}

type Ticket = {
  id: string
  name: string
  totalMatches: number
  selections: Record<string, string>
  stakeTzs: number
  correctCount: number
  status: string
  prizeTzs: number
  matches: Match[]
}

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const jackpots = ref<Jackpot[]>([])
const tickets = ref<Ticket[]>([])
const openId = ref('')
const picks = ref<Record<string, string>>({})
const missing = ref<number[]>([])
const error = ref('')
const bought = ref(false)
const buying = ref(false)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`
const openJackpot = computed(() => jackpots.value.find((row) => row.id === openId.value) ?? null)

function typeName(type: string) {
  if (type === 'mega10') return 'Mega 10'
  if (type === 'power8') return 'Power 8'
  return type
}

function when(iso: string) {
  return new Date(iso).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function countdown(iso: string) {
  const left = new Date(iso).getTime() - now.value
  if (left <= 0) return t('jp.closed')
  const total = Math.floor(left / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  return days > 0 ? `${days}d ${clock}` : clock
}

function tiersOf(row: Jackpot) {
  return Object.entries(row.tierPrizes)
    .map(([count, prize]) => ({ count: Number(count), prize }))
    .sort((a, b) => b.count - a.count)
}

function sideLabel(side: string | null | undefined) {
  if (side === 'home') return '1'
  if (side === 'draw') return 'X'
  if (side === 'away') return '2'
  if (side === 'void') return t('jp.void')
  return '—'
}

function statusLabel(status: string) {
  if (status === 'won' || status === 'lost' || status === 'pending' || status === 'refunded') return t(`jp.${status}`)
  return status
}

function odd(value: number | null) {
  return value == null ? '' : value.toFixed(2)
}

async function load() {
  const data = await api<{ data: Jackpot[] }>('/api/jackpots')
  jackpots.value = data.data
  if (openId.value && !data.data.some((row) => row.id === openId.value)) openId.value = ''
  if (auth.user) {
    const mine = await api<{ data: Ticket[] }>('/api/jackpot-tickets')
    tickets.value = mine.data
  } else {
    tickets.value = []
  }
}

function play(row: Jackpot) {
  openId.value = row.id
  picks.value = {}
  missing.value = []
  error.value = ''
  bought.value = false
}

function choose(position: number, side: string) {
  picks.value = { ...picks.value, [String(position)]: side }
  missing.value = missing.value.filter((item) => item !== position)
}

async function buy() {
  const row = openJackpot.value
  if (!row || buying.value) return
  error.value = ''
  bought.value = false
  if (!auth.user) {
    await router.push('/login')
    return
  }
  const gaps = row.matches
    .filter((match) => !['home', 'draw', 'away'].includes(picks.value[String(match.position)] ?? ''))
    .map((match) => match.position)
  missing.value = gaps
  if (gaps.length) {
    error.value = 'picks'
    return
  }
  buying.value = true
  try {
    const result = await api<{ balanceTzs: number | null }>(`/api/jackpots/${row.id}/tickets`, {
      method: 'POST',
      json: { selections: { ...picks.value }, idempotencyKey: crypto.randomUUID() },
    })
    if (result.balanceTzs != null && auth.user) auth.user.balanceTzs = result.balanceTzs
    bought.value = true
    picks.value = {}
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    buying.value = false
  }
}

function errorText() {
  const key = `jp.err_${error.value}`
  const text = t(key)
  return text === key ? t('jp.err_generic') : text
}

onMounted(async () => {
  try {
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  }
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div data-testid="jackpot-page">
    <h2>{{ $t('jp.title') }}</h2>

    <section v-if="openJackpot" class="card" data-testid="jackpot-play">
      <button type="button" @click="openId = ''">{{ $t('jp.back') }}</button>
      <h3>{{ openJackpot.name }} · {{ typeName(openJackpot.type) }}</h3>
      <p class="jackpot-count" data-testid="jackpot-countdown">{{ countdown(openJackpot.closingTime) }}</p>
      <p>{{ $t('jp.stake') }} <b>{{ money(openJackpot.stakeTzs) }}</b> · {{ $t('jp.grand') }} <b class="gold">{{ money(openJackpot.grandPrizeTzs) }}</b></p>
      <p class="muted">{{ $t('jp.tiers') }}:
        <span v-for="tier in tiersOf(openJackpot)" :key="tier.count"> {{ tier.count }}/{{ openJackpot.totalMatches }} {{ money(tier.prize) }}</span>
      </p>
      <p class="muted">{{ $t('jp.picks') }} {{ $t('jp.voidHelp') }}</p>
      <p v-if="error" class="form-error" data-testid="jackpot-error">{{ errorText() }}</p>
      <p v-if="bought" data-testid="jackpot-bought">{{ $t('jp.bought') }}</p>
      <div
        v-for="match in openJackpot.matches"
        :key="match.position"
        class="jackpot-match"
        :class="{ missing: missing.includes(match.position) }"
        :data-testid="`jackpot-match-${match.position}`"
      >
        <div>
          <b>{{ match.position }}. {{ match.home }}</b> vs <b>{{ match.away }}</b>
          <div class="muted">{{ match.league }} · {{ when(match.kickoff) }}</div>
        </div>
        <div class="jackpot-picks">
          <button type="button" :class="{ on: picks[String(match.position)] === 'home' }" :data-testid="`jackpot-pick-${match.position}-home`" @click="choose(match.position, 'home')">1 <small>{{ odd(match.odds.home) }}</small></button>
          <button type="button" :class="{ on: picks[String(match.position)] === 'draw' }" :data-testid="`jackpot-pick-${match.position}-draw`" @click="choose(match.position, 'draw')">X <small>{{ odd(match.odds.draw) }}</small></button>
          <button type="button" :class="{ on: picks[String(match.position)] === 'away' }" :data-testid="`jackpot-pick-${match.position}-away`" @click="choose(match.position, 'away')">2 <small>{{ odd(match.odds.away) }}</small></button>
        </div>
      </div>
      <button type="button" class="deposit-btn" data-testid="jackpot-buy" :disabled="buying" @click="buy">
        {{ buying ? $t('jp.buying') : auth.user ? $t('jp.buy') : $t('jp.login') }}
      </button>
    </section>

    <section v-else>
      <h3>{{ $t('jp.open') }}</h3>
      <p v-if="!jackpots.length" class="muted" data-testid="jackpot-empty">{{ $t('jp.empty') }}</p>
      <div class="jackpot-list">
        <article v-for="row in jackpots" :key="row.id" class="jackpot-card" data-testid="jackpot-card">
          <div class="muted">{{ typeName(row.type) }}</div>
          <h3>{{ row.name }}</h3>
          <p class="jackpot-count" data-testid="jackpot-countdown">{{ countdown(row.closingTime) }}</p>
          <p>{{ $t('jp.closes') }} {{ when(row.closingTime) }}</p>
          <p>{{ $t('jp.grand') }} <b class="gold">{{ money(row.grandPrizeTzs) }}</b></p>
          <p>{{ $t('jp.stake') }} {{ money(row.stakeTzs) }} · {{ $t('jp.players') }} {{ row.participants }} · {{ $t('jp.pool') }} {{ money(row.prizePoolTzs) }}</p>
          <p class="muted">
            <span v-for="tier in tiersOf(row)" :key="tier.count">{{ tier.count }}/{{ row.totalMatches }} {{ money(tier.prize) }} </span>
          </p>
          <button type="button" data-testid="jackpot-play-open" @click="play(row)">{{ $t('jp.play') }}</button>
        </article>
      </div>
    </section>

    <section data-testid="jackpot-tickets">
      <h3>{{ $t('jp.mine') }}</h3>
      <p v-if="!auth.user" class="muted">{{ $t('jp.login') }}</p>
      <p v-else-if="!tickets.length" class="muted">{{ $t('jp.noTickets') }}</p>
      <article v-for="ticket in tickets" :key="ticket.id" class="card" data-testid="jackpot-ticket">
        <b>{{ ticket.name }}</b>
        <p>{{ statusLabel(ticket.status) }} · {{ $t('jp.correct') }} {{ ticket.correctCount }}/{{ ticket.totalMatches }} · {{ $t('jp.stake') }} {{ money(ticket.stakeTzs) }} · {{ $t('jp.prize') }} {{ money(ticket.prizeTzs) }}</p>
        <p v-for="match in ticket.matches" :key="match.position" class="muted">
          {{ match.position }}. {{ match.home }} vs {{ match.away }}
          · {{ $t('jp.pick') }} {{ sideLabel(ticket.selections[String(match.position)]) }}
          · {{ $t('jp.result') }} {{ sideLabel(match.result) }}
          <span v-if="match.status === 'finished'"> ({{ match.homeScore }}-{{ match.awayScore }})</span>
        </p>
      </article>
    </section>
  </div>
</template>
