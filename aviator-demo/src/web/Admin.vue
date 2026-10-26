<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Flight from './Flight.vue'
import { demoApi } from './demo-api'

interface PlayerRow {
  id: string
  name: string
  balance: number
  bot: boolean
  color: string
  initials: string
  bet: null | {
    stake: number
    auto: number | null
    status: string
    cashoutAt: number | null
    payout: number
    marked: boolean
  }
}

interface Snap {
  phase: string
  multiplier: number
  countdownMs: number
  roundNo: number
  viewerCount: number
  current: {
    roundNo: number
    phase: string
    mode: string
    crashPoint: number | null
    takeoffMs: number
    flyAwayMs: number
    flyLeftMs: number | null
    winnerIds: string[]
  }
  plan: {
    mode: string
    crash: number | null
    takeoffMs: number
    flyAwayMs: number
    winnerIds: string[]
    winnerNames: string[]
  }
  players: PlayerRow[]
  log: { id: number, at: number, kind: string, text: string }[]
}

const snap = ref<Snap | null>(null)
const error = ref('')
const saved = ref('')
const crash = ref(2.5)
const takeoffSec = ref(4)
const flySec = ref(6)
const selected = ref<string[]>([])
const busy = ref(false)
let source: EventSource | null = null
let poll: ReturnType<typeof setInterval> | undefined

const currentText = computed(() => {
  const cur = snap.value?.current
  if (!cur) return 'Waiting'
  if (cur.mode === 'manual' && cur.crashPoint != null) {
    const fly = cur.flyAwayMs > 0 ? ` · fly away ${(cur.flyAwayMs / 1000).toFixed(1)}s` : ' · natural flight'
    const left = cur.flyLeftMs != null ? ` · ${Math.ceil(cur.flyLeftMs / 1000)}s left` : ''
    return `Round ${cur.roundNo} · manual · crash ${cur.crashPoint.toFixed(2)}x${fly}${left}`
  }
  return `Round ${cur.roundNo} · automatic`
})

const nextText = computed(() => {
  const plan = snap.value?.plan
  if (!plan || plan.mode === 'automatic') return 'Next: automatic'
  const fly = plan.flyAwayMs > 0 ? `${(plan.flyAwayMs / 1000).toFixed(1)}s` : 'natural'
  const names = plan.winnerNames.length ? plan.winnerNames.join(', ') : 'none'
  return `Next: manual · crash ${Number(plan.crash ?? 0).toFixed(2)}x · takeoff ${(plan.takeoffMs / 1000).toFixed(1)}s · fly away ${fly} · winners ${names}`
})

function money(n: number) {
  return `TSh ${Math.trunc(n || 0).toLocaleString('en-US')}`
}

function applySnap(data: Snap) {
  snap.value = data
}

async function load() {
  try { applySnap(await demoApi<Snap>('/api/admin/state')) } catch { /* keep the last frame */ }
}

function listen() {
  if (typeof EventSource === 'undefined') {
    poll = setInterval(() => { void load() }, 400)
    return
  }
  source = new EventSource('/api/admin/stream')
  source.onmessage = (ev) => {
    try { applySnap(JSON.parse(ev.data) as Snap) } catch { /* ignore a bad frame */ }
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
})

onUnmounted(() => {
  source?.close()
  if (poll) clearInterval(poll)
})

function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : [...selected.value, id]
}

function explain(err: unknown) {
  const code = err instanceof Error ? err.message : 'demo_error'
  const text: Record<string, string> = {
    crash_out_of_range: 'Crash must be from 1.10 to 100.',
    takeoff_out_of_range: 'Takeoff must be from 1 to 30 seconds.',
    flyaway_out_of_range: 'Fly away must be 0 (natural) or from 0.5 to 60 seconds.',
    winners_invalid: 'Pick players from the list.',
  }
  return text[code] ?? 'Could not update the next round.'
}

async function savePlan() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/plan', {
      crash: crash.value,
      takeoffMs: Math.round(takeoffSec.value * 1000),
      flyAwayMs: flySec.value <= 0 ? 0 : Math.round(flySec.value * 1000),
    }))
    saved.value = 'Queued for the next round. This round is unchanged.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function mark() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/winners', { playerIds: selected.value }))
    saved.value = 'Selected players will cash out before the crash on the next round.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function automatic() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/automatic', {}))
    saved.value = 'The next round is automatic again.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="demo-admin" data-testid="demo-admin">
    <Flight
      :phase="snap?.phase ?? 'betting'"
      :multiplier="snap?.multiplier ?? 1"
      :countdown-ms="snap?.countdownMs ?? 0"
      :viewer-count="snap?.viewerCount ?? 0"
    />

    <p class="demo-current" data-testid="demo-current">{{ currentText }}</p>
    <p class="demo-next" data-testid="demo-next">{{ nextText }}</p>
    <p v-if="saved" class="demo-saved" data-testid="demo-saved">{{ saved }}</p>
    <p v-if="error" class="form-error" data-testid="demo-admin-error">{{ error }}</p>

    <form class="demo-controls" @submit.prevent="savePlan">
      <label>Next crash
        <input type="number" step="0.01" min="1.1" max="100" v-model.number="crash" data-testid="demo-crash" />
      </label>
      <label>Takeoff (seconds)
        <input type="number" step="1" min="1" max="30" v-model.number="takeoffSec" data-testid="demo-takeoff" />
      </label>
      <label>Fly away (seconds, 0 = natural)
        <input type="number" step="0.5" min="0" max="60" v-model.number="flySec" data-testid="demo-flyaway" />
      </label>
      <div class="demo-actions">
        <button type="submit" class="primary" :disabled="busy" data-testid="demo-apply">Apply to next round</button>
        <button type="button" class="warn" :disabled="busy" data-testid="demo-winners" @click="mark">Mark selected to win</button>
        <button type="button" :disabled="busy" data-testid="demo-automatic" @click="automatic">Automatic</button>
      </div>
    </form>

    <div class="demo-admin-grid">
      <div class="card">
        <h2>Demo players</h2>
        <div class="demo-scroll">
          <table class="demo-table">
            <thead>
              <tr><th></th><th>Player</th><th>Demo credit</th><th>Stake</th><th>Auto</th><th>Status</th></tr>
            </thead>
            <tbody>
              <tr v-for="player in snap?.players ?? []" :key="player.id" data-testid="demo-player-row" :data-player="player.id" :data-status="player.bet?.status ?? 'waiting'">
                <td><input type="checkbox" data-testid="demo-select" :data-player="player.id" :checked="selected.includes(player.id)" @change="toggle(player.id)" /></td>
                <td><span class="av-avatar" :style="{ background: player.color }">{{ player.initials }}</span> {{ player.name }}</td>
                <td>{{ money(player.balance) }}</td>
                <td>{{ player.bet ? money(player.bet.stake) : '—' }}</td>
                <td>{{ player.bet?.auto ? player.bet.auto.toFixed(2) + 'x' : '—' }}</td>
                <td>
                  <span v-if="player.bet?.status === 'cashed'">Cashed {{ player.bet.cashoutAt?.toFixed(2) }}x · {{ money(player.bet.payout) }}</span>
                  <span v-else-if="player.bet">{{ player.bet.status }}<template v-if="player.bet.marked"> · marked</template></span>
                  <span v-else class="muted">waiting</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>Live log</h2>
        <div class="demo-log" data-testid="demo-log">
          <p v-for="line in snap?.log ?? []" :key="line.id" data-testid="demo-log-line" :data-kind="line.kind">{{ line.text }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
