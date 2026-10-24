<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Fixture = {
  id: number
  home: string
  away: string
  league: string
  kickoff: string
  odds: { home: number | null; draw: number | null; away: number | null }
}

type Match = Fixture & {
  position: number
  status: string
  homeScore: number
  awayScore: number
  result: string | null
  matchId: number
}

type Jackpot = {
  id: string
  type: 'mega10' | 'power8'
  name: string
  stakeTzs: number
  grandPrizeTzs: number
  tierPrizes: Record<string, number>
  closingTime: string
  status: string
  prizePoolTzs: number
  participants: number
  totalMatches: number
  matches: Match[]
}

type Ticket = {
  id: string
  phone: string
  selections: Record<string, string>
  stakeTzs: number
  correctCount: number
  status: string
  prizeTzs: number
}

const PRESETS: Record<'mega10' | 'power8', { stake: number; grand: number; tiers: { correct: number; prize: number }[] }> = {
  mega10: { stake: 1000, grand: 10_000_000, tiers: [{ correct: 9, prize: 100_000 }, { correct: 8, prize: 20_000 }] },
  power8: { stake: 5000, grand: 5_000_000, tiers: [{ correct: 7, prize: 50_000 }, { correct: 6, prize: 10_000 }] },
}

const { t, locale } = useI18n()
const fixtures = ref<Fixture[]>([])
const jackpots = ref<Jackpot[]>([])
const tickets = ref<Ticket[]>([])
const ticketJackpot = ref('')
const winnersOnly = ref(false)
const search = ref('')
const selected = ref<number[]>([])
const settleFor = ref('')
const results = ref<Record<number, string>>({})
const reason = ref('')
const error = ref('')
const notice = ref('')
const saving = ref(false)

function hoursAhead(hours: number) {
  const date = new Date(Date.now() + hours * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const form = ref({
  type: 'power8' as 'mega10' | 'power8',
  name: 'Power 8 Jackpot',
  stake: PRESETS.power8.stake,
  grand: PRESETS.power8.grand,
  tiers: PRESETS.power8.tiers.map((tier) => ({ ...tier })),
  closing: hoursAhead(2),
})

const needed = computed(() => (form.value.type === 'mega10' ? 10 : 8))
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

const visibleFixtures = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return fixtures.value
  return fixtures.value.filter((row) => `${row.home} ${row.away} ${row.league}`.toLowerCase().includes(q))
})

const shownTickets = computed(() => (winnersOnly.value ? tickets.value.filter((row) => row.status === 'won') : tickets.value))

function when(iso: string) {
  return new Date(iso).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function typeName(type: string) {
  return type === 'mega10' ? 'Mega 10' : 'Power 8'
}

function sideLabel(side: string | null | undefined) {
  if (side === 'home') return '1'
  if (side === 'draw') return 'X'
  if (side === 'away') return '2'
  if (side === 'void') return t('jp.void')
  return '—'
}

function applyType(type: 'mega10' | 'power8') {
  const preset = PRESETS[type]
  form.value.type = type
  form.value.name = type === 'mega10' ? 'Mega 10 Jackpot' : 'Power 8 Jackpot'
  form.value.stake = preset.stake
  form.value.grand = preset.grand
  form.value.tiers = preset.tiers.map((tier) => ({ ...tier }))
  if (selected.value.length > (type === 'mega10' ? 10 : 8)) selected.value = selected.value.slice(0, type === 'mega10' ? 10 : 8)
}

function positionOf(id: number) {
  const index = selected.value.indexOf(id)
  return index < 0 ? 0 : index + 1
}

function toggle(id: number) {
  const index = selected.value.indexOf(id)
  if (index >= 0) selected.value = selected.value.filter((item) => item !== id)
  else if (selected.value.length < needed.value) selected.value = [...selected.value, id]
}

async function load() {
  const [listed, upcoming] = await Promise.all([
    api<{ data: Jackpot[] }>('/api/admin/jackpots'),
    api<{ data: Fixture[] }>('/api/admin/jackpot-fixtures'),
  ])
  jackpots.value = listed.data
  fixtures.value = upcoming.data
}

function say(code: string) {
  const key = `jp.${code}`
  const text = t(key)
  return text === key ? code : text
}

async function create() {
  error.value = ''
  notice.value = ''
  if (selected.value.length !== needed.value) {
    error.value = 'adminCount'
    return
  }
  const tiers: Record<string, number> = {}
  for (const tier of form.value.tiers) {
    if (tier.correct > 0 && tier.prize > 0) tiers[String(tier.correct)] = Number(tier.prize)
  }
  saving.value = true
  try {
    await api('/api/admin/jackpots', {
      method: 'POST',
      json: {
        type: form.value.type,
        name: form.value.name,
        stakeTzs: Number(form.value.stake),
        grandPrizeTzs: Number(form.value.grand),
        tierPrizes: tiers,
        closingTime: new Date(form.value.closing).toISOString(),
        matchIds: [...selected.value],
      },
    })
    selected.value = []
    notice.value = 'adminSaved'
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'err_generic'
  } finally {
    saving.value = false
  }
}

async function openTickets(id: string) {
  ticketJackpot.value = id
  settleFor.value = ''
  const data = await api<{ data: Ticket[] }>(`/api/admin/jackpots/${id}/tickets`)
  tickets.value = data.data
}

function openSettle(row: Jackpot) {
  settleFor.value = row.id
  ticketJackpot.value = ''
  const next: Record<number, string> = {}
  for (const match of row.matches) next[match.position] = ''
  results.value = next
}

async function settle(row: Jackpot) {
  error.value = ''
  notice.value = ''
  const entered = row.matches
    .filter((match) => ['home', 'draw', 'away', 'void'].includes(results.value[match.position] ?? ''))
    .map((match) => ({ position: match.position, result: results.value[match.position] }))
  try {
    const result = await api<{ pending: boolean; already: boolean; paid: number; allVoid: boolean }>(`/api/admin/jackpots/${row.id}/settle`, {
      method: 'POST',
      json: { results: entered },
    })
    notice.value = result.pending ? 'adminPending' : result.allVoid ? 'adminCancelled' : 'adminSettled'
    settleFor.value = ''
    await load()
    if (ticketJackpot.value) await openTickets(ticketJackpot.value)
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'err_generic'
  }
}

async function cancel(id: string) {
  error.value = ''
  notice.value = ''
  if (reason.value.trim().length < 3) {
    error.value = 'err_validation'
    return
  }
  try {
    await api(`/api/admin/jackpots/${id}/cancel`, { method: 'POST', json: { reason: reason.value.trim() } })
    notice.value = 'adminCancelled'
    reason.value = ''
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'err_generic'
  }
}

async function remove(id: string) {
  error.value = ''
  notice.value = ''
  try {
    await api(`/api/admin/jackpots/${id}/delete`, { method: 'POST', json: {} })
    notice.value = 'adminDeleted'
    if (ticketJackpot.value === id) ticketJackpot.value = ''
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? (err.code === 'has_tickets' ? 'err_has_tickets' : err.code) : 'err_generic'
  }
}

function slip(row: Ticket) {
  return Object.keys(row.selections)
    .sort((a, b) => Number(a) - Number(b))
    .map((pos) => `${pos}:${sideLabel(row.selections[pos])}`)
    .join(' ')
}

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'err_generic' }
})
</script>

<template>
  <div data-testid="admin-jackpots">
    <p v-if="error" class="form-error" data-testid="admin-jp-error">{{ say(error.startsWith('err_') || error.startsWith('admin') ? error : `err_${error}`) }}</p>
    <p v-if="notice" data-testid="admin-jp-notice">{{ say(notice) }}</p>
    <p class="muted">{{ $t('jp.voidHelp') }}</p>

    <section class="card">
      <h3>{{ $t('jp.adminCreate') }}</h3>
      <div class="jackpot-form">
        <label>{{ $t('jp.adminType') }}
          <select v-model="form.type" data-testid="admin-jp-type" @change="applyType(form.type)">
            <option value="mega10">Mega 10</option>
            <option value="power8">Power 8</option>
          </select>
        </label>
        <label>{{ $t('jp.adminName') }}
          <input v-model="form.name" data-testid="admin-jp-name" maxlength="80" />
        </label>
        <label>{{ $t('jp.adminStake') }}
          <input v-model.number="form.stake" type="number" min="100" step="1" data-testid="admin-jp-stake" />
        </label>
        <label>{{ $t('jp.adminGrand') }}
          <input v-model.number="form.grand" type="number" min="1" step="1" data-testid="admin-jp-grand" />
        </label>
        <label>{{ $t('jp.adminClose') }}
          <input v-model="form.closing" type="datetime-local" data-testid="admin-jp-closing" />
        </label>
      </div>
      <div v-for="(tier, index) in form.tiers" :key="index" class="jackpot-form">
        <label>{{ $t('jp.adminTier') }} {{ index + 1 }} · {{ $t('jp.adminCorrect') }}
          <input v-model.number="tier.correct" type="number" min="1" :max="needed - 1" :data-testid="`admin-jp-tier-count-${index}`" />
        </label>
        <label>{{ $t('jp.adminPrize') }}
          <input v-model.number="tier.prize" type="number" min="1" step="1" :data-testid="`admin-jp-tier-prize-${index}`" />
        </label>
      </div>
      <p>{{ $t('jp.adminNeed', { n: needed }) }} {{ $t('jp.adminSelected', { n: selected.length, total: needed }) }}</p>
      <input v-model="search" :placeholder="$t('jp.adminSearch')" data-testid="admin-jp-search" />
      <p v-if="!fixtures.length" class="muted">{{ $t('jp.adminNoFixtures') }}</p>
      <label v-for="row in visibleFixtures" :key="row.id" class="jackpot-fixture" data-testid="admin-jp-fixture">
        <input type="checkbox" :checked="selected.includes(row.id)" :disabled="!selected.includes(row.id) && selected.length >= needed" @change="toggle(row.id)" />
        <span v-if="positionOf(row.id)" class="hot-badge">{{ positionOf(row.id) }}</span>
        <span>{{ row.home }} vs {{ row.away }} · {{ row.league }} · {{ when(row.kickoff) }}
          <small class="muted"> {{ row.odds.home ?? '-' }} / {{ row.odds.draw ?? '-' }} / {{ row.odds.away ?? '-' }}</small>
        </span>
      </label>
      <button type="button" data-testid="admin-jp-save" :disabled="saving" @click="create">{{ $t('jp.adminSave') }}</button>
    </section>

    <article v-for="row in jackpots" :key="row.id" class="card" data-testid="admin-jp-row">
      <div class="muted">{{ typeName(row.type) }} · {{ row.status }}</div>
      <h3>{{ row.name }}</h3>
      <p>{{ $t('jp.grand') }} <b class="gold">{{ money(row.grandPrizeTzs) }}</b> · {{ $t('jp.stake') }} {{ money(row.stakeTzs) }}</p>
      <p>{{ $t('jp.players') }} {{ row.participants }} · {{ $t('jp.pool') }} {{ money(row.prizePoolTzs) }} · {{ $t('jp.closes') }} {{ when(row.closingTime) }}</p>
      <p v-for="match in row.matches" :key="match.position" class="muted">
        {{ match.position }}. {{ match.home }} vs {{ match.away }} · {{ match.status }}
        <span v-if="match.result"> · {{ sideLabel(match.result) }}</span>
      </p>
      <div class="chips">
        <button type="button" data-testid="admin-jp-tickets" @click="openTickets(row.id)">{{ $t('jp.adminTickets') }}</button>
        <button v-if="row.status !== 'settled' && row.status !== 'cancelled'" type="button" data-testid="admin-jp-settle" @click="openSettle(row)">{{ $t('jp.adminSettle') }}</button>
        <button v-if="row.status === 'open'" type="button" data-testid="admin-jp-cancel" @click="cancel(row.id)">{{ $t('jp.adminCancel') }}</button>
        <button type="button" data-testid="admin-jp-delete" @click="remove(row.id)">{{ $t('jp.adminDelete') }}</button>
      </div>
      <div v-if="settleFor === row.id" class="card" data-testid="admin-jp-settle-form">
        <label v-for="match in row.matches" :key="match.position">
          {{ match.position }}. {{ match.home }} vs {{ match.away }}
          <select v-model="results[match.position]" :data-testid="`admin-jp-result-${match.position}`">
            <option value="">{{ $t('jp.adminDerive') }}</option>
            <option value="home">1</option>
            <option value="draw">X</option>
            <option value="away">2</option>
            <option value="void">{{ $t('jp.void') }}</option>
          </select>
        </label>
        <button type="button" data-testid="admin-jp-settle-go" @click="settle(row)">{{ $t('jp.adminSettle') }}</button>
      </div>
      <div v-if="row.status === 'open'">
        <input v-model="reason" :placeholder="$t('jp.adminReason')" data-testid="admin-jp-reason" />
      </div>
      <div v-if="ticketJackpot === row.id" data-testid="admin-jp-ticket-list">
        <div class="chips">
          <button type="button" :class="{ active: !winnersOnly }" @click="winnersOnly = false">{{ $t('jp.adminAll') }}</button>
          <button type="button" :class="{ active: winnersOnly }" @click="winnersOnly = true">{{ $t('jp.adminWinners') }}</button>
        </div>
        <p v-if="!shownTickets.length" class="muted">{{ $t('adminNoRows') }}</p>
        <p v-for="ticket in shownTickets" :key="ticket.id" data-testid="admin-jp-ticket-row">
          <b>{{ ticket.phone }}</b> · {{ ticket.status }} · {{ ticket.correctCount }}/{{ row.totalMatches }} · {{ money(ticket.stakeTzs) }} · {{ money(ticket.prizeTzs) }}
          <span class="muted"> {{ slip(ticket) }}</span>
        </p>
      </div>
    </article>
  </div>
</template>
