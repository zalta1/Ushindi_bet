<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { PenaltyScene, type ZoneScreen } from '../penalty/scene'
import { useAuth } from '../stores/store'

type Zone = { zoneKey: string; label: string; multiplier: number; displayOrder: number; isActive: boolean }
type Limits = {
  enabled: boolean
  minStake: number
  maxStake: number
  maxPayout: number
  budgetEnabled: boolean
  chips: number[]
  step: number
}
type Shot = {
  id: string
  stakeTzs: number
  zoneKey: string
  keeperZone: string
  multiplier: number
  outcome: 'goal' | 'saved' | 'miss'
  payoutTzs: number
  createdAt: string
}

const ZONE_I18N: Record<string, string> = {
  'top-left': 'topLeft',
  'top-center': 'topCenter',
  'top-right': 'topRight',
  'mid-left': 'midLeft',
  'mid-center': 'midCenter',
  'mid-right': 'midRight',
  'bottom-left': 'bottomLeft',
  'bottom-center': 'bottomCenter',
  'bottom-right': 'bottomRight',
}

const auth = useAuth()
const router = useRouter()
const { t, locale } = useI18n()
const limits = ref<Limits | null>(null)
const zones = ref<Zone[]>([])
const history = ref<Shot[]>([])
const selected = ref('')
const stakeTzs = ref(1000)
const result = ref<Shot | null>(null)
const phase = ref<'idle' | 'shooting' | 'result'>('idle')
const error = ref('')
const busy = ref(false)
const markers = ref<ZoneScreen[]>([])
const canvas = ref<HTMLCanvasElement | null>(null)
let pitch: PenaltyScene | null = null

const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`
const plain = (n: number) => Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')

function zoneName(zone: { zoneKey: string; label: string }) {
  if (locale.value === 'en') return t(`penalty.zone.${ZONE_I18N[zone.zoneKey] ?? 'midCenter'}`)
  return zone.label
}

function shotName(key: string) {
  const zone = zones.value.find((item) => item.zoneKey === key)
  if (locale.value === 'en') return t(`penalty.zone.${ZONE_I18N[key] ?? 'midCenter'}`)
  return zone?.label ?? key
}

const aims = computed(() => markers.value.flatMap((marker) => {
  const zone = zones.value.find((item) => item.zoneKey === marker.key)
  if (!zone) return []
  return [{ ...marker, multiplier: zone.multiplier, label: zoneName(zone) }]
}))

const potential = computed(() => {
  const zone = zones.value.find((item) => item.zoneKey === selected.value)
  if (!zone || !limits.value) return 0
  const raw = Math.floor((stakeTzs.value * Math.round(zone.multiplier * 100)) / 100)
  return Math.min(raw, limits.value.maxPayout)
})

function errorText() {
  if (!error.value) return ''
  const key = `penalty.err_${error.value}`
  const text = t(key)
  return text === key ? t('penalty.err_generic') : text
}

function clampStake(value: number) {
  const min = limits.value?.minStake ?? 500
  const max = limits.value?.maxStake ?? 100_000
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function nudge(dir: number) {
  if (phase.value === 'shooting') return
  const step = limits.value?.step ?? 500
  stakeTzs.value = clampStake(stakeTzs.value + dir * step)
}

async function load() {
  const data = await api<{ limits: Limits; zones: Zone[]; history: Shot[] }>('/api/penalty')
  limits.value = data.limits
  zones.value = [...data.zones].sort((a, b) => a.displayOrder - b.displayOrder)
  history.value = data.history
  stakeTzs.value = clampStake(stakeTzs.value || 1000)
  if (selected.value && !zones.value.some((zone) => zone.zoneKey === selected.value)) selected.value = ''
}

function pick(key: string) {
  if (phase.value === 'shooting') return
  selected.value = key
  error.value = ''
}

async function shoot() {
  error.value = ''
  if (!auth.user) {
    await router.push('/login')
    return
  }
  if (!limits.value?.enabled) {
    error.value = 'game_disabled'
    return
  }
  if (!selected.value) {
    error.value = 'zone'
    return
  }
  if (busy.value || phase.value === 'shooting') return
  stakeTzs.value = clampStake(stakeTzs.value)
  if (auth.user.balanceTzs < stakeTzs.value) {
    error.value = 'insufficient_funds'
    return
  }
  busy.value = true
  phase.value = 'shooting'
  result.value = null
  pitch?.armAudio()
  pitch?.setAimVisible(false)
  try {
    const response = await api<{ balanceTzs: number; shot: Shot }>('/api/penalty/shoot', {
      method: 'POST',
      json: { zoneKey: selected.value, stakeTzs: stakeTzs.value, idempotencyKey: crypto.randomUUID() },
    })
    if (auth.user) auth.user.balanceTzs = response.balanceTzs - response.shot.payoutTzs
    if (pitch) {
      await pitch.shoot({
        outcome: response.shot.outcome,
        target: response.shot.zoneKey,
        keeper: response.shot.keeperZone,
      })
    }
    if (auth.user) auth.user.balanceTzs = response.balanceTzs
    result.value = response.shot
    phase.value = 'result'
    history.value = [response.shot, ...history.value].slice(0, 20)
    pitch?.setAimVisible(true)
  } catch (err) {
    phase.value = 'idle'
    pitch?.setAimVisible(true)
    error.value = err instanceof ApiClientError ? err.code : 'generic'
  } finally {
    busy.value = false
  }
}

watch(phase, (next) => {
  pitch?.setAimVisible(next !== 'shooting')
})

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'generic' }
  if (!canvas.value) return
  try {
    const scene = new PenaltyScene(canvas.value)
    scene.onMarkers = (list) => {
      const prev = markers.value
      const same = prev.length === list.length && prev.every((item, index) => {
        const next = list[index]
        return item.key === next.key && Math.abs(item.left - next.left) < 0.6 && Math.abs(item.top - next.top) < 0.6
      })
      if (!same) markers.value = list
    }
    scene.setAimVisible(true)
    pitch = scene
  } catch {
    error.value = 'webgl'
  }
})

onBeforeUnmount(() => {
  pitch?.dispose()
  pitch = null
})
</script>

<template>
  <div data-testid="penalty-page" class="penalty">
    <h2>{{ $t('penalty.title') }}</h2>
    <p class="muted" data-testid="penalty-fairness">{{ limits?.budgetEnabled ? $t('penalty.house') : $t('penalty.fair') }}</p>
    <p v-if="limits && !limits.enabled" class="form-error">{{ $t('penalty.err_game_disabled') }}</p>
    <p v-if="error" class="form-error" data-testid="penalty-error">{{ errorText() }}</p>
    <p class="muted" data-testid="penalty-phase" :data-phase="phase">{{ phase === 'shooting' ? $t('penalty.shooting') : $t('penalty.pick') }}</p>

    <section class="penalty-stage card">
      <canvas ref="canvas" data-testid="penalty-canvas" />
      <div class="penalty-zones">
        <button
          v-for="aim in aims"
          v-show="phase !== 'shooting'"
          :key="aim.key"
          type="button"
          class="penalty-zone"
          :class="{ on: selected === aim.key }"
          :style="{ left: `${aim.left}px`, top: `${aim.top}px` }"
          :data-testid="`penalty-zone-${aim.key}`"
          :title="aim.label"
          :aria-label="aim.label"
          @click="pick(aim.key)"
        >{{ aim.multiplier }}×</button>
      </div>
      <div v-if="phase === 'result' && result" class="penalty-overlay" :class="result.outcome" data-testid="penalty-result" :data-outcome="result.outcome">
        <b>{{ $t(`penalty.${result.outcome}`) }}</b>
        <span v-if="result.outcome === 'goal'">+{{ plain(result.payoutTzs) }} TZS</span>
        <span v-else>{{ shotName(result.zoneKey) }}</span>
      </div>
    </section>

    <div class="penalty-controls">
      <button type="button" data-testid="penalty-stake-dec" :disabled="phase === 'shooting'" @click="nudge(-1)">−</button>
      <label>{{ $t('penalty.stake') }}
        <input v-model.number="stakeTzs" data-testid="penalty-stake" type="number" inputmode="numeric" :min="limits?.minStake ?? 500" :max="limits?.maxStake ?? 100000" :step="limits?.step ?? 500" :disabled="phase === 'shooting'" />
      </label>
      <button type="button" data-testid="penalty-stake-inc" :disabled="phase === 'shooting'" @click="nudge(1)">+</button>
      <button
        v-for="chip in (limits?.chips ?? []).filter((value) => !limits || value >= limits.minStake && value <= limits.maxStake)"
        :key="chip"
        type="button"
        :data-testid="`penalty-chip-${chip}`"
        :disabled="phase === 'shooting'"
        @click="stakeTzs = chip"
      >{{ plain(chip) }}</button>
    </div>
    <p v-if="selected" data-testid="penalty-selected">{{ shotName(selected) }} · {{ potential ? money(potential) : '' }}</p>
    <button type="button" class="penalty-shoot" data-testid="penalty-shoot" :disabled="busy || phase === 'shooting' || !limits?.enabled" @click="shoot">
      {{ phase === 'shooting' ? $t('penalty.shooting') : $t('penalty.shoot') }}
    </button>
    <p v-if="!auth.user" class="muted">{{ $t('penalty.login') }}</p>

    <section data-testid="penalty-history">
      <h3>{{ $t('penalty.history') }}</h3>
      <p v-if="!history.length" class="muted">{{ $t('penalty.noHistory') }}</p>
      <p v-for="shot in history" :key="shot.id" data-testid="penalty-history-row">
        {{ shotName(shot.zoneKey) }} · {{ $t(`penalty.${shot.outcome}`) }} · {{ money(shot.stakeTzs) }} → {{ money(shot.payoutTzs) }}
      </p>
    </section>
  </div>
</template>
