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

interface ScheduleSnap {
  status: 'idle' | 'running' | 'paused'
  mode: 'sequence' | 'timed'
  finished: boolean
  countdown: string
  capSec: number
  cursor: number
  total: number
  progress: string
  entries: { crash: number, at: string | null, winnerIds: string[], winnerNames: string[], state: 'done' | 'current' | 'next' | 'upcoming' }[]
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
    scheduleIndex: number | null
    scheduleTotal: number
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
  schedule: ScheduleSnap
  nairobiNow: string
}

const snap = ref<Snap | null>(null)
const error = ref('')
const saved = ref('')
const crash = ref(2.5)
const takeoffSec = ref(4)
const flySec = ref(6)
const selected = ref<string[]>([])
const busy = ref(false)
const DEFAULT_ODDS = [1.2, 3.5, 2.1, 1.5, 5, 1.8, 2.4, 8, 1.15, 4.2]
let rowKey = 1
const rows = ref(DEFAULT_ODDS.map((crash) => ({ key: rowKey++, crash, at: '', winnerIds: [] as string[] })))
const capSec = ref(3)
const scheduleMode = ref<'sequence' | 'timed'>('sequence')
let source: EventSource | null = null
let poll: ReturnType<typeof setInterval> | undefined

const currentText = computed(() => {
  const cur = snap.value?.current
  if (!cur) return 'Waiting'
  if (cur.scheduleIndex != null && cur.crashPoint != null) {
    const fly = cur.flyAwayMs > 0 ? ` · fly away ${(cur.flyAwayMs / 1000).toFixed(1)}s` : ' · natural flight'
    const left = cur.flyLeftMs != null ? ` · ${Math.ceil(cur.flyLeftMs / 1000)}s left` : ''
    return `Round ${cur.roundNo} · schedule ${cur.scheduleIndex + 1} of ${cur.scheduleTotal} · crash ${cur.crashPoint.toFixed(2)}x${fly}${left}`
  }
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
    schedule_too_short: 'Back to back needs 10 odds. Timed needs at least one.',
    schedule_odd_invalid: 'Each odd must be from 1.00 to 1000.',
    schedule_time_invalid: 'Each timed odd needs a Nairobi time, HH:MM:SS.',
    schedule_time_past: 'Times must still be ahead on the Nairobi clock.',
    schedule_time_duplicate: 'Two odds cannot share the same time.',
    schedule_cap_invalid: 'Time cap must be from 0.5 to 60 seconds.',
    schedule_not_running: 'Start the schedule first.',
    schedule_not_paused: 'The schedule is not paused.',
  }
  return text[code] ?? 'Could not update the next round.'
}

function addRow() {
  rows.value.push({ key: rowKey++, crash: 2, at: '', winnerIds: [] })
}

function sortTimed() {
  if (scheduleMode.value !== 'timed') return
  rows.value = [...rows.value].sort((a, b) => {
    if (!a.at && !b.at) return 0
    if (!a.at) return 1
    if (!b.at) return -1
    return a.at.localeCompare(b.at)
  })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

function moveRow(index: number, dir: -1 | 1) {
  const next = index + dir
  if (next < 0 || next >= rows.value.length) return
  const copy = rows.value.slice()
  const [item] = copy.splice(index, 1)
  copy.splice(next, 0, item)
  rows.value = copy
}

function useSelected(index: number) {
  rows.value[index].winnerIds = [...selected.value]
}

async function startSchedule() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/schedule/start', {
      mode: scheduleMode.value,
      capSec: capSec.value,
      entries: rows.value.map((row) => ({ crash: row.crash, at: row.at, winnerIds: row.winnerIds })),
    }))
    saved.value = 'Schedule queued. It starts on the next round.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function pauseSchedule() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/schedule/pause', {}))
    saved.value = 'Schedule paused after this round.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function resumeSchedule() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/schedule/resume', {}))
    saved.value = 'Schedule resumed.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function stopSchedule() {
  error.value = ''
  saved.value = ''
  busy.value = true
  try {
    applySnap(await demoApi<Snap>('/api/admin/schedule/stop', {}))
    saved.value = 'Schedule stopped. The next round is automatic.'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
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

    <section class="card demo-schedule" data-testid="demo-schedule">
      <h2>Odds schedule</h2>
      <p class="muted" v-if="scheduleMode === 'sequence'">Back to back needs at least 10 odds and runs them in order. The climb stays inside the time cap, then play returns to Automatic.</p>
      <p class="muted" v-else>Timed odds use the Nairobi clock. Fewer than 10 is fine. Between times the demo plays Automatic rounds, or waits if the next odd is soon. If a round is still flying, the odd starts as soon as it ends and is logged as delayed.</p>
      <p data-testid="demo-nairobi-clock">Nairobi {{ snap?.nairobiNow ?? '—' }}</p>
      <p v-if="snap?.schedule?.countdown" data-testid="demo-schedule-countdown">{{ snap.schedule.countdown }}</p>
      <p data-testid="demo-schedule-progress">{{ snap?.schedule?.progress ?? 'Schedule idle' }}</p>
      <div class="demo-actions" v-if="snap?.schedule?.status !== 'running' && snap?.schedule?.status !== 'paused'">
        <button type="button" :class="{ active: scheduleMode === 'sequence' }" data-testid="demo-schedule-mode-sequence" @click="scheduleMode = 'sequence'">Back to back</button>
        <button type="button" :class="{ active: scheduleMode === 'timed' }" data-testid="demo-schedule-mode-timed" @click="scheduleMode = 'timed'">Timed</button>
      </div>
      <label>Time cap (seconds)
        <input type="number" step="0.5" min="0.5" max="60" v-model.number="capSec" data-testid="demo-schedule-cap" :disabled="snap?.schedule?.status === 'running'" />
      </label>

      <div v-if="snap?.schedule?.status === 'running' || snap?.schedule?.status === 'paused' || snap?.schedule?.finished" class="schedule-list" data-testid="demo-schedule-live">
        <div
          v-for="(entry, index) in snap.schedule.entries"
          :key="index"
          class="schedule-row"
          :class="entry.state"
          data-testid="demo-schedule-row"
          :data-state="entry.state"
          :data-odd="entry.crash.toFixed(2)"
        >
          <span class="schedule-tick">{{ entry.state === 'done' ? '✓' : (index + 1) }}</span>
          <b>{{ entry.crash.toFixed(2) }}x</b>
          <span v-if="entry.at">{{ entry.at }}</span>
          <span class="muted">{{ entry.winnerNames.length ? entry.winnerNames.join(', ') : 'no marked winners' }}</span>
          <span class="schedule-tag">{{ entry.state }}</span>
        </div>
      </div>
      <div v-else class="schedule-list" data-testid="demo-schedule-editor">
        <div v-for="(row, index) in rows" :key="row.key" class="schedule-row" data-testid="demo-schedule-edit">
          <span>{{ index + 1 }}</span>
          <input type="number" step="0.01" min="1" max="1000" v-model.number="row.crash" data-testid="demo-schedule-odd" />
          <input v-if="scheduleMode === 'timed'" type="time" step="1" v-model="row.at" data-testid="demo-schedule-time" @change="sortTimed" />
          <span class="muted">{{ row.winnerIds.length ? `${row.winnerIds.length} winner(s)` : 'optional winners' }}</span>
          <span class="schedule-actions">
            <button type="button" data-testid="demo-schedule-up" @click="moveRow(index, -1)">Up</button>
            <button type="button" data-testid="demo-schedule-down" @click="moveRow(index, 1)">Down</button>
            <button type="button" data-testid="demo-schedule-winners" @click="useSelected(index)">Use selected</button>
            <button type="button" data-testid="demo-schedule-remove" @click="removeRow(index)">Remove</button>
          </span>
        </div>
        <button type="button" data-testid="demo-schedule-add" @click="addRow">Add odd</button>
      </div>

      <div class="demo-actions">
        <button v-if="snap?.schedule?.status !== 'running' && snap?.schedule?.status !== 'paused'" type="button" class="primary" :disabled="busy" data-testid="demo-schedule-start" @click="startSchedule">Start</button>
        <button v-if="snap?.schedule?.status === 'running'" type="button" class="warn" :disabled="busy" data-testid="demo-schedule-pause" @click="pauseSchedule">Pause</button>
        <button v-if="snap?.schedule?.status === 'paused'" type="button" class="primary" :disabled="busy" data-testid="demo-schedule-resume" @click="resumeSchedule">Resume</button>
        <button v-if="snap?.schedule?.status === 'running' || snap?.schedule?.status === 'paused'" type="button" :disabled="busy" data-testid="demo-schedule-stop" @click="stopSchedule">Stop</button>
      </div>
    </section>

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
