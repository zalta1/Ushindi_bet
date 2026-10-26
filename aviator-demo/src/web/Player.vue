<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Flight from './Flight.vue'
import { demoApi } from './demo-api'

interface PublicBet {
  id: string
  panel: number
  stake: number
  payout: number
  status: string
  cashoutAt: number | null
  auto: number | null
  name: string
  initials: string
  color: string
}

interface Snap {
  phase: string
  multiplier: number
  countdownMs: number
  roundNo: number
  mode: string
  serverSeedHash: string
  serverSeed: string | null
  crashPoint: number | null
  nonce: number
  history: { roundNo: number, crashPoint: number }[]
  viewerCount: number
  limits: { minStake: number, maxStake: number, rtpPct: number }
  bets: PublicBet[]
  you: { id: string, name: string, balance: number, bets: PublicBet[] } | null
}

const snap = ref<Snap | null>(null)
const error = ref('')
const name = ref('Asha Demo')
const tab = ref<'bets' | 'winners'>('bets')
const stake = ref([500, 500])
const autoOn = ref([false, false])
const autoAt = ref([2, 2])
const busy = ref(false)
const liveMult = ref(1)
let source: EventSource | null = null
let poll: ReturnType<typeof setInterval> | undefined

const you = computed(() => snap.value?.you ?? null)
const winners = computed(() => (snap.value?.bets ?? []).filter((bet) => bet.status === 'cashed'))

function money(n: number) {
  return `TSh ${Math.trunc(n || 0).toLocaleString('en-US')}`
}

function pill(mult: number) {
  if (mult >= 10) return 'av-pill purple'
  if (mult >= 5) return 'av-pill pink'
  if (mult >= 2) return 'av-pill green'
  return 'av-pill blue'
}

function explain(err: unknown) {
  const code = err instanceof Error ? err.message : 'demo_error'
  const text: Record<string, string> = {
    invalid_name: 'Use a name made of letters.',
    betting_closed: 'Betting is closed for this round.',
    insufficient_demo_credit: 'Not enough demo credit.',
    already_bet: 'That panel already has a bet.',
    demo_login_required: 'Enter the demo first.',
    not_flying: 'The plane is not flying.',
    cashout_closed: 'Cash out is closed.',
  }
  return text[code] ?? 'Something went wrong.'
}

function apply(data: Snap) {
  snap.value = data
}

async function load() {
  try { apply(await demoApi<Snap>('/api/state')) } catch { /* keep the last frame */ }
}

function listen() {
  source?.close()
  source = null
  if (poll) clearInterval(poll)
  poll = undefined
  if (typeof EventSource === 'undefined') {
    poll = setInterval(() => { void load() }, 400)
    return
  }
  source = new EventSource('/api/stream')
  source.onmessage = (ev) => {
    try { apply(JSON.parse(ev.data) as Snap) } catch { /* ignore a bad frame */ }
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

function mine(panel: number) {
  return you.value?.bets.find((bet) => bet.panel === panel)
}

async function enter(next = name.value) {
  error.value = ''
  busy.value = true
  try {
    await demoApi('/api/login', { name: next })
    name.value = next
    listen()
    await load()
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function place(panel: number) {
  error.value = ''
  busy.value = true
  try {
    await demoApi('/api/bet', {
      stake: stake.value[panel - 1],
      panel,
      auto: autoOn.value[panel - 1] ? autoAt.value[panel - 1] : null,
    })
    await load()
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function cashOut(panel: number) {
  error.value = ''
  busy.value = true
  try {
    await demoApi('/api/cashout', { panel })
    await load()
  } catch (err) {
    error.value = explain(err)
    await load()
  } finally {
    busy.value = false
  }
}

function preview(panel: number) {
  const bet = mine(panel)
  if (!bet) return 0
  const mult = snap.value?.phase === 'flying' ? (liveMult.value || snap.value.multiplier) : 1
  return Math.round((bet.stake * Math.round(mult * 100)) / 100)
}
</script>

<template>
  <div data-testid="demo-player">
    <div class="aviator" data-testid="aviator-game">
      <div class="av-main">
        <div class="av-history" data-testid="aviator-history">
          <span v-for="item in snap?.history ?? []" :key="item.roundNo" :class="pill(item.crashPoint)">{{ item.crashPoint.toFixed(2) }}x</span>
          <span v-if="!snap?.history.length" class="muted">No rounds yet</span>
        </div>

        <Flight
          :phase="snap?.phase ?? 'betting'"
          :multiplier="snap?.multiplier ?? 1"
          :countdown-ms="snap?.countdownMs ?? 0"
          :viewer-count="snap?.viewerCount ?? 0"
          @live="liveMult = $event"
        />

        <p class="demo-mode" data-testid="demo-round-mode">{{ snap?.mode === 'manual' ? 'Presentation round' : 'Automatic round' }}</p>
        <p v-if="error" class="form-error" data-testid="aviator-error">{{ error }}</p>

        <div class="av-panels">
          <form v-for="panel in [1, 2]" :key="panel" class="av-panel" @submit.prevent="mine(panel)?.status === 'active' && snap?.phase === 'flying' ? cashOut(panel) : place(panel)">
            <div class="av-panel-head">
              <b>Panel {{ panel }}</b>
              <span v-if="mine(panel)?.status === 'cashed'">{{ mine(panel)!.cashoutAt?.toFixed(2) }}x</span>
            </div>
            <label>Stake
              <input type="number" v-model.number="stake[panel - 1]" :min="snap?.limits.minStake ?? 100" :max="snap?.limits.maxStake ?? 100000" step="100" :data-testid="`aviator-stake-${panel}`" />
            </label>
            <label class="check">
              <input type="checkbox" v-model="autoOn[panel - 1]" :data-testid="`aviator-auto-${panel}`" />
              Auto cash out
            </label>
            <label v-if="autoOn[panel - 1]">Auto at
              <input type="number" step="0.01" min="1.01" v-model.number="autoAt[panel - 1]" :data-testid="`aviator-auto-at-${panel}`" />
            </label>
            <button v-if="!you" type="button" @click="enter()">Enter demo</button>
            <button
              v-else-if="mine(panel)?.status === 'active' && snap?.phase === 'flying'"
              type="submit"
              class="av-cash"
              :disabled="busy"
              :data-testid="`aviator-cashout-${panel}`"
            >Cash out {{ money(preview(panel)) }}</button>
            <button v-else-if="mine(panel)?.status === 'cashed'" type="button" disabled>Cashed {{ mine(panel)!.cashoutAt?.toFixed(2) }}x</button>
            <button v-else-if="mine(panel)?.status === 'active'" type="button" disabled :data-testid="`aviator-placed-${panel}`">Bet placed</button>
            <button v-else type="submit" class="av-bet" :disabled="busy || snap?.phase !== 'betting'" :data-testid="`aviator-bet-${panel}`">Bet</button>
            <small class="muted">Demo stake {{ snap?.limits.minStake ?? 100 }}–{{ snap?.limits.maxStake ?? 100000 }}. Fake credit only.</small>
          </form>
        </div>
        <p class="av-fair" data-testid="demo-hash">Hash {{ snap?.serverSeedHash }}</p>
        <p v-if="snap?.serverSeed" class="av-fair" data-testid="demo-seed">Seed {{ snap.serverSeed }} · nonce {{ snap.nonce }} · crash {{ snap.crashPoint?.toFixed(2) }}x</p>
      </div>

      <aside class="av-side">
        <div class="demo-login">
          <p v-if="you" data-testid="demo-balance"><b>{{ you.name }}</b><br />Demo credit {{ money(you.balance) }}</p>
          <template v-else>
            <label>Demo name
              <input v-model="name" maxlength="32" data-testid="demo-login-name" />
            </label>
            <button type="button" class="av-bet" data-testid="demo-login" :disabled="busy" @click="enter()">Enter with fake credit</button>
          </template>
          <div class="chips">
            <button v-for="preset in ['Asha Demo', 'Peter Demo', 'Witness Demo']" :key="preset" type="button" data-testid="demo-preset" :data-name="preset" @click="enter(preset)">{{ preset }}</button>
          </div>
        </div>

        <div class="chips">
          <button type="button" :class="{ active: tab === 'bets' }" data-testid="aviator-tab-bets" @click="tab = 'bets'">Bets</button>
          <button type="button" :class="{ active: tab === 'winners' }" data-testid="aviator-tab-winners" @click="tab = 'winners'">Winners</button>
        </div>

        <div v-if="tab === 'bets'" data-testid="aviator-live-bets">
          <p v-if="!snap?.bets.length" class="muted">No bets this round</p>
          <div v-for="bet in snap?.bets ?? []" :key="bet.id" class="av-row">
            <span class="av-avatar" :style="{ background: bet.color }">{{ bet.initials }}</span>
            <span>{{ bet.name }}</span>
            <b>{{ money(bet.stake) }}</b>
            <span v-if="bet.cashoutAt">{{ bet.cashoutAt.toFixed(2) }}x</span>
            <span v-else class="muted">{{ bet.status }}</span>
          </div>
        </div>
        <div v-else data-testid="aviator-winners">
          <p v-if="!winners.length" class="muted">No cash outs yet</p>
          <div v-for="bet in winners" :key="bet.id" class="av-row">
            <span class="av-avatar" :style="{ background: bet.color }">{{ bet.initials }}</span>
            <span>{{ bet.name }}</span>
            <b class="gold">{{ money(bet.payout) }}</b>
            <span>{{ bet.cashoutAt?.toFixed(2) }}x</span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
