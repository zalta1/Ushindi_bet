<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Segment = { multiplier: number; color: string; label: string }
type Target = { id: string; multiplier: number; color: string; emoji: string; label: string }
type Limits = {
  enabled: boolean
  minStake: number
  maxStake: number
  maxWin: number
  budgetEnabled: boolean
  chips: number[]
  segments: Segment[]
  targets: Target[]
}
type Spin = {
  id: string
  stakeTzs: number
  bets: Record<string, number>
  winIdx: number
  multiplier: number
  label: string
  payoutTzs: number
  won: boolean
  createdAt: string
}

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const limits = ref<Limits | null>(null)
const bets = ref<Record<string, number>>({})
const chip = ref(50)
const history = ref<Spin[]>([])
const result = ref<Spin | null>(null)
const phase = ref<'betting' | 'spinning' | 'result'>('betting')
const error = ref('')
const busy = ref(false)
const rotation = ref(0)
const canvas = ref<HTMLCanvasElement | null>(null)
let frame = 0
let hold: ReturnType<typeof setTimeout> | null = null

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`
const plain = (n: number) => Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')
const total = computed(() => Object.values(bets.value).reduce((sum, amount) => sum + amount, 0))
const locked = computed(() => busy.value || phase.value !== 'betting')

function errorText() {
  if (!error.value) return ''
  const key = `mayan.err_${error.value}`
  const text = t(key)
  return text === key ? t('mayan.err_generic') : text
}

function targetTestId(id: string) {
  return `mayan-target-${id.replace('.', '-')}`
}

function chipLabel(amount: number) {
  if (amount >= 1000 && amount % 1000 === 0) return `${amount / 1000}k`
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`
  return String(amount)
}

async function load() {
  const data = await api<{ limits: Limits; history: Spin[] }>('/api/mayan')
  limits.value = data.limits
  history.value = data.history
  const chips = data.limits.chips.filter((value) => value >= data.limits.minStake)
  if (chips.length && !chips.includes(chip.value)) chip.value = chips[0]
}

function addBet(id: string) {
  if (locked.value) return
  if (!auth.user) {
    void router.push('/login')
    return
  }
  const next = total.value + chip.value
  if (auth.user.balanceTzs < next) {
    error.value = 'insufficient_funds'
    return
  }
  error.value = ''
  bets.value = { ...bets.value, [id]: (bets.value[id] ?? 0) + chip.value }
}

function clearBets() {
  if (locked.value) return
  bets.value = {}
}

function doubleBets() {
  if (locked.value || total.value === 0 || !auth.user) return
  let running = 0
  const next: Record<string, number> = {}
  for (const [id, amount] of Object.entries(bets.value)) {
    running += amount * 2
    if (running > auth.user.balanceTzs) {
      error.value = 'double'
      return
    }
    next[id] = amount * 2
  }
  error.value = ''
  bets.value = next
}

function betAll() {
  if (locked.value || !auth.user || !limits.value) return
  const share = Math.floor(auth.user.balanceTzs / limits.value.targets.length)
  if (share < limits.value.minStake) {
    error.value = 'insufficient_funds'
    return
  }
  const next: Record<string, number> = {}
  for (const target of limits.value.targets) next[target.id] = share
  error.value = ''
  bets.value = next
}

function drawWheel() {
  const el = canvas.value
  const segments = limits.value?.segments
  if (!el || !segments?.length) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const size = el.width
  const center = size / 2
  const radius = center - 8
  const count = segments.length
  const arc = (2 * Math.PI) / count
  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.translate(center, center)
  ctx.rotate((rotation.value * Math.PI) / 180)
  ctx.translate(-center, -center)
  for (let i = 0; i < count; i++) {
    const start = i * arc - Math.PI / 2
    const segment = segments[i]
    ctx.beginPath()
    ctx.moveTo(center, center)
    ctx.arc(center, center, radius, start, start + arc)
    ctx.closePath()
    ctx.fillStyle = segment.color
    ctx.fill()
    ctx.strokeStyle = '#8B6914'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.save()
    ctx.translate(center, center)
    ctx.rotate(start + arc / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${segment.multiplier >= 100 ? 10 : 11}px Arial`
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 2
    ctx.fillText(segment.label, radius * 0.7, 0)
    ctx.shadowBlur = 0
    ctx.restore()
  }
  ctx.beginPath()
  ctx.arc(center, center, radius * 0.18, 0, 2 * Math.PI)
  ctx.fillStyle = '#1a0e00'
  ctx.fill()
  ctx.strokeStyle = '#D4A017'
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(center, center, radius + 4, 0, 2 * Math.PI)
  ctx.strokeStyle = '#D4A017'
  ctx.lineWidth = 6
  ctx.stroke()
  for (let i = 0; i < count; i++) {
    const angle = i * arc - Math.PI / 2
    const x = center + (radius + 4) * Math.cos(angle)
    const y = center + (radius + 4) * Math.sin(angle)
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, 2 * Math.PI)
    ctx.fillStyle = '#FFD700'
    ctx.fill()
  }
  ctx.restore()
  ctx.beginPath()
  ctx.moveTo(center, 4)
  ctx.lineTo(center - 10, 0)
  ctx.lineTo(center + 10, 0)
  ctx.closePath()
  ctx.fillStyle = '#DC143C'
  ctx.fill()
  ctx.strokeStyle = '#FFD700'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(center, 18)
  ctx.lineTo(center - 7, 2)
  ctx.lineTo(center + 7, 2)
  ctx.closePath()
  ctx.fillStyle = '#DC143C'
  ctx.fill()
}

function animateTo(index: number) {
  const segment = 360 / (limits.value?.segments.length || 24)
  const targetMod = (360 - (index + 0.5) * segment + 3600) % 360
  const currentMod = ((rotation.value % 360) + 360) % 360
  let delta = targetMod - currentMod
  if (delta < 0) delta += 360
  delta += 360 * (5 + Math.random() * 3)
  const start = rotation.value
  const duration = 4000
  const started = performance.now()
  return new Promise<void>((resolve) => {
    const step = (now: number) => {
      const t = Math.min((now - started) / duration, 1)
      const eased = 1 - (1 - t) ** 3
      rotation.value = start + delta * eased
      drawWheel()
      if (t < 1) frame = requestAnimationFrame(step)
      else resolve()
    }
    frame = requestAnimationFrame(step)
  })
}

async function spin() {
  error.value = ''
  if (!auth.user) {
    await router.push('/login')
    return
  }
  if (!limits.value?.enabled) {
    error.value = 'game_disabled'
    return
  }
  if (locked.value || total.value <= 0) return
  if (auth.user.balanceTzs < total.value) {
    error.value = 'insufficient_funds'
    return
  }
  busy.value = true
  phase.value = 'spinning'
  result.value = null
  if (hold) clearTimeout(hold)
  try {
    const response = await api<{ balanceTzs: number; spin: Spin }>('/api/mayan/spin', {
      method: 'POST',
      json: { bets: { ...bets.value }, idempotencyKey: crypto.randomUUID() },
    })
    if (auth.user) auth.user.balanceTzs = response.balanceTzs - response.spin.payoutTzs
    await animateTo(response.spin.winIdx)
    if (auth.user) auth.user.balanceTzs = response.balanceTzs
    result.value = response.spin
    phase.value = 'result'
    history.value = [response.spin, ...history.value].slice(0, 20)
    hold = setTimeout(() => {
      phase.value = 'betting'
      bets.value = {}
      result.value = null
    }, 3000)
  } catch (err) {
    phase.value = 'betting'
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    busy.value = false
  }
}

watch(limits, () => drawWheel())
watch(rotation, () => drawWheel())

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'generic' }
  drawWheel()
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  if (hold) clearTimeout(hold)
})
</script>

<template>
  <div data-testid="mayan-page" class="mayan">
    <h2>{{ $t('mayan.title') }}</h2>
    <p class="muted" data-testid="mayan-fairness">{{ limits?.budgetEnabled ? $t('mayan.house') : $t('mayan.fair') }}</p>
    <p v-if="limits && !limits.enabled" class="form-error">{{ $t('mayan.err_game_disabled') }}</p>
    <p v-if="error" class="form-error" data-testid="mayan-error">{{ errorText() }}</p>

    <section class="mayan-board card">
      <div class="mayan-wheel">
        <canvas ref="canvas" data-testid="mayan-wheel" width="280" height="280" />
        <div class="mayan-hub" data-testid="mayan-phase">{{ phase === 'betting' ? $t('mayan.accepting') : phase === 'spinning' ? $t('mayan.spinning') : '' }}</div>
        <div v-if="phase === 'result' && result" class="mayan-overlay">
          <div data-testid="mayan-result" :class="result.won ? 'win' : 'loss'">
            <template v-if="result.won">
              <b>{{ result.payoutTzs >= 10000 ? $t('mayan.mega') : $t('mayan.winTitle') }}</b>
              <span>+{{ plain(result.payoutTzs) }} TZS</span>
            </template>
            <template v-else>{{ $t('mayan.loss', { label: result.label }) }}</template>
          </div>
        </div>
      </div>

      <div v-if="limits" class="mayan-targets">
        <button
          v-for="target in limits.targets"
          :key="target.id"
          type="button"
          class="mayan-target"
          :class="{ has: (bets[target.id] ?? 0) > 0, hit: result && `x${result.multiplier}` === target.id }"
          :style="{ backgroundColor: target.color + '55' }"
          :data-testid="targetTestId(target.id)"
          :disabled="locked"
          @click="addBet(target.id)"
        >
          <span class="mayan-label">{{ target.label }}</span>
          <span class="mayan-emoji">{{ target.emoji }}</span>
          <span v-if="bets[target.id]" class="mayan-chip-badge">{{ chipLabel(bets[target.id]) }}</span>
        </button>
      </div>

      <div class="mayan-controls">
        <p data-testid="mayan-total">{{ $t('mayan.total') }} <b>{{ plain(total) }} TZS</b></p>
        <button type="button" data-testid="mayan-bet-all" :disabled="locked || !auth.user" @click="betAll">{{ $t('mayan.betAll') }}</button>
        <div class="mayan-chip-row">
          <button type="button" class="mayan-round" data-testid="mayan-clear" :disabled="locked || total === 0" @click="clearBets">{{ $t('mayan.clear') }}</button>
          <button type="button" class="mayan-round" data-testid="mayan-double" :disabled="locked || total === 0" @click="doubleBets">x2</button>
          <select v-model.number="chip" data-testid="mayan-chip" :disabled="locked">
            <option v-for="amount in (limits?.chips ?? []).filter((value) => !limits || value >= limits.minStake)" :key="amount" :value="amount">TZS {{ plain(amount) }}</option>
          </select>
          <button type="button" class="mayan-spin" data-testid="mayan-spin" :disabled="locked || total === 0 || !limits?.enabled" @click="spin">
            {{ busy ? '…' : '▶' }}
          </button>
        </div>
        <p v-if="!auth.user" class="muted">{{ $t('mayan.login') }}</p>
      </div>
    </section>

    <section data-testid="mayan-history">
      <h3>{{ $t('mayan.history') }}</h3>
      <p v-if="!history.length" class="muted">{{ $t('mayan.noHistory') }}</p>
      <p v-for="spinRow in history" :key="spinRow.id" data-testid="mayan-history-row">
        {{ spinRow.label }} · {{ money(spinRow.stakeTzs) }} → {{ money(spinRow.payoutTzs) }} · {{ spinRow.won ? $t('mayan.winTitle') : $t('mayan.lossShort') }}
      </p>
    </section>
  </div>
</template>
