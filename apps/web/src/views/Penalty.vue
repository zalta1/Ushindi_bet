<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { penaltyAudio, type CommentaryEvent, type PenaltyAudioSettings } from '../penalty/audio'
import { useAuth } from '../stores/store'

type Zone = { zoneKey: string; label: string; multiplier: number; displayOrder: number; isActive: boolean }
type Limits = { enabled: boolean; minStake: number; maxStake: number; maxPayout: number; chips: number[] }
type Shot = {
  id: string
  stakeTzs: number
  zoneKey: string
  keeperZone: string
  multiplier: number
  outcome: 'goal' | 'saved' | 'miss'
  payoutTzs: number
  nonce: number
}
type Point = { x: number; y: number }

const AIM: Record<string, Point> = {
  'top-left': { x: 12, y: 22 },
  'top-center': { x: 50, y: 20 },
  'top-right': { x: 88, y: 22 },
  'mid-left': { x: 10, y: 52 },
  'mid-center': { x: 50, y: 52 },
  'mid-right': { x: 90, y: 52 },
  'bottom-left': { x: 12, y: 82 },
  'bottom-center': { x: 50, y: 84 },
  'bottom-right': { x: 88, y: 82 },
}
const ORDER = Object.keys(AIM)
const CHIPS = [500, 1000, 2000, 5000, 10000]
const ASSET = {
  stadium: '/penalty/penalty-stadium-v3.jpg',
  keeperLeft: '/penalty/penalty-keeper-left-v3.png',
  keeperRight: '/penalty/penalty-keeper-right-v3.png',
  keeperCenter: '/penalty/penalty-keeper-center-v3.png',
  stand: '/penalty/penalty-striker-stand-v3.png',
  kick: '/penalty/penalty-striker-kick-v3.png',
  ball: '/penalty/penalty-football.png',
  intro: '/penalty/penalty-intro.mp4',
  goal: '/penalty/penalty-goal.mp4',
  save: '/penalty/penalty-save.mp4',
  miss: '/penalty/penalty-miss.mp4',
}

const auth = useAuth()
const router = useRouter()
const limits = ref<Limits | null>(null)
const zones = ref<Zone[]>([])
const history = ref<Shot[]>([])
const selected = ref<string | null>(null)
const stakeTzs = ref(1000)
const phase = ref<'idle' | 'shooting' | 'result'>('idle')
const result = ref<Shot | null>(null)
const ball = ref<Point | null>(null)
const ballMoves = ref(false)
const keeperZone = ref('mid-center')
const kicking = ref(false)
const intro = ref(true)
const videoOutcome = ref<Shot['outcome'] | null>(null)
const replay = ref<'live' | 'replay'>('live')
const side = ref<'left' | 'center' | 'right'>('center')
const soundOpen = ref(false)
const historyOpen = ref(false)
const toast = ref('')
const sound = ref<PenaltyAudioSettings>(penaltyAudio.getSettings())
const videoEl = ref<HTMLVideoElement | null>(null)
let pending: { balanceTzs: number; shot: Shot } | null = null
const timers: number[] = []

const money = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US')
const balance = computed(() => auth.user?.balanceTzs ?? 0)
const zoneByKey = (key: string | null) => zones.value.find((zone) => zone.zoneKey === key) ?? null
const chosen = computed(() => zoneByKey(selected.value))
const potential = computed(() => (chosen.value ? Math.round(stakeTzs.value * Number(chosen.value.multiplier)) : 0))
const minStake = computed(() => limits.value?.minStake ?? 500)
const maxStake = computed(() => limits.value?.maxStake ?? 100_000)
const chips = computed(() => (limits.value?.chips?.length ? limits.value.chips : CHIPS).filter((chip) => chip >= minStake.value && chip <= maxStake.value))
const rail = computed(() => {
  const sorted = [...zones.value].sort((a, b) => Number(a.multiplier) - Number(b.multiplier))
  return sorted
    .filter((_, index, list) => list.length <= 5 || index % Math.ceil(list.length / 5) === 0)
    .slice(0, 5)
    .map((zone) => ({ key: zone.zoneKey, multiplier: Number(zone.multiplier) }))
})
const railWidth = computed(() => {
  if (rail.value.length <= 1) return '0%'
  const index = rail.value.findIndex((item) => item.key === selected.value)
  return `${((index + 1) / rail.value.length) * 100}%`
})
const keeperPoint = computed(() => AIM[keeperZone.value] ?? AIM['mid-center'])
const keeperSide = computed(() => (keeperPoint.value.x < 40 ? 'left' : keeperPoint.value.x > 60 ? 'right' : 'center'))
const keeperSrc = computed(() => (keeperSide.value === 'left' ? ASSET.keeperLeft : keeperSide.value === 'right' ? ASSET.keeperRight : ASSET.keeperCenter))
const pitchScale = computed(() => (kicking.value ? 1.14 : phase.value === 'result' ? 1.08 : 1))
const videoSrc = computed(() => (videoOutcome.value === 'goal' ? ASSET.goal : videoOutcome.value === 'saved' ? ASSET.save : ASSET.miss))

function later(fn: () => void, ms: number) {
  const id = window.setTimeout(fn, ms)
  timers.push(id)
}
function clearTimers() {
  timers.splice(0).forEach((id) => window.clearTimeout(id))
}
function show(message: string) {
  toast.value = message
  window.setTimeout(() => { if (toast.value === message) toast.value = '' }, 3200)
}
function clampStake(value: number) {
  if (!Number.isFinite(value)) return minStake.value
  return Math.min(maxStake.value, Math.max(minStake.value, value))
}
function nudge(delta: number) {
  stakeTzs.value = clampStake(stakeTzs.value + delta)
}
function chipLabel(value: number) {
  return value >= 1000 ? `${value / 1000}K` : String(value)
}
function fly(next: Point) {
  if (!ball.value) {
    ballMoves.value = false
    ball.value = { x: 50, y: 168 }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ballMoves.value = true
        ball.value = next
      })
    })
    return
  }
  ballMoves.value = true
  ball.value = next
}
function patchSound(patch: Partial<PenaltyAudioSettings>) {
  penaltyAudio.setSettings(patch)
  sound.value = penaltyAudio.getSettings()
  if (patch.stadiumOn) penaltyAudio.startAmbience()
}

async function load() {
  const data = await api<{ limits: Limits; zones: Zone[]; history: Shot[] }>('/api/penalty')
  limits.value = data.limits
  zones.value = data.zones
  history.value = data.history ?? []
  stakeTzs.value = Math.max(stakeTzs.value, data.limits.minStake)
}

function reveal() {
  clearTimers()
  videoOutcome.value = null
  replay.value = 'live'
  if (!pending) return
  result.value = pending.shot
  phase.value = 'result'
  pending = null
}
function onVideoEnded() {
  const node = videoEl.value
  if (replay.value === 'live' && node) {
    replay.value = 'replay'
    try {
      node.currentTime = 0
      node.playbackRate = 0.45
      void node.play()
    } catch {
      reveal()
    }
    return
  }
  reveal()
}
function again() {
  clearTimers()
  videoOutcome.value = null
  result.value = null
  phase.value = 'idle'
  ball.value = null
  ballMoves.value = false
  keeperZone.value = 'mid-center'
  kicking.value = false
}

async function shoot() {
  if (!auth.user) { show('Ingia kwenye akaunti yako kwanza'); return }
  if (limits.value && !limits.value.enabled) { show('Mchezo umezimwa kwa sasa'); return }
  if (!selected.value) { show('Chagua eneo la kulenga kwanza'); return }
  if (stakeTzs.value > balance.value) { show('Salio halitoshi'); return }
  if (balance.value >= 10_000_000) {
    show('Salio lako limefikia kikomo cha TSH 10,000,000. Tafadhali toa pesa zako kwanza ili uendelee kucheza. Account haiwezi kuwa na zaidi ya TSH 10,000,000.')
    return
  }
  clearTimers()
  videoOutcome.value = null
  replay.value = 'live'
  phase.value = 'shooting'
  result.value = null
  kicking.value = true
  penaltyAudio.unlock()
  penaltyAudio.startAmbience()
  penaltyAudio.say('pre')
  try {
    const response = await api<{ balanceTzs: number; shot: Shot }>('/api/penalty/shoot', {
      method: 'POST',
      json: { zoneKey: selected.value, stakeTzs: stakeTzs.value, idempotencyKey: crypto.randomUUID() },
    })
    pending = response
    const aim = AIM[response.shot.zoneKey] ?? AIM['mid-center']
    side.value = aim.x < 45 ? 'left' : aim.x > 55 ? 'right' : 'center'
    later(() => {
      penaltyAudio.kick()
      penaltyAudio.say('shoot', 120)
      penaltyAudio.crowd(0.5, 1.2)
      keeperZone.value = response.shot.keeperZone
      if (response.shot.outcome === 'goal') fly(aim)
      else if (response.shot.outcome === 'saved') fly({ x: aim.x, y: Math.min(aim.y + 6, 88) })
      else {
        const wide = aim.x < 50 ? -22 : 122
        fly(aim.y < 40 ? { x: aim.x, y: -34 } : { x: wide, y: aim.y })
      }
    }, 260)
    if (response.shot.outcome === 'saved') {
      later(() => fly({ x: aim.x < 50 ? aim.x - 26 : aim.x + 26, y: 104 }), 900)
    }
    later(() => {
      kicking.value = false
      if (auth.user) auth.user.balanceTzs = response.balanceTzs
      replay.value = 'live'
      videoOutcome.value = response.shot.outcome
      history.value = [response.shot, ...history.value.filter((shot) => shot.id !== response.shot.id)].slice(0, 20)
      const mult = Number(response.shot.multiplier) || 0
      if (response.shot.outcome === 'goal') {
        penaltyAudio.net()
        penaltyAudio.crowd(mult >= 20 ? 1 : mult >= 10 ? 0.85 : 0.6, mult >= 20 ? 3 : 2)
        penaltyAudio.say('goal', 150)
        const line: CommentaryEvent | null = mult >= 35 ? 'mult_35' : mult >= 20 ? 'mult_20' : mult >= 10 ? 'mult_10' : mult >= 5 ? 'mult_5' : null
        if (line) later(() => { penaltyAudio.say(line); penaltyAudio.crowd(1, 2.5) }, 2100)
      } else if (response.shot.outcome === 'saved') {
        penaltyAudio.keeperSave()
        penaltyAudio.crowd(0.55, 1.4)
        penaltyAudio.say('save', 150)
      } else {
        penaltyAudio.crowdGroan()
        penaltyAudio.say('miss', 200)
      }
    }, 900)
    later(() => reveal(), 16_000)
  } catch (err) {
    kicking.value = false
    phase.value = 'idle'
    const code = err instanceof ApiClientError ? err.code : ''
    show(code === 'insufficient_funds' ? 'Salio halitoshi' : code === 'game_disabled' ? 'Mchezo umezimwa kwa sasa' : code === 'unauthenticated' ? 'Ingia kwenye akaunti yako kwanza' : 'Hitilafu imetokea')
  }
}

onMounted(() => {
  penaltyAudio.unlock()
  penaltyAudio.startAmbience()
  const introTimer = window.setTimeout(() => { intro.value = false }, 5200)
  timers.push(introTimer)
  load().catch(() => show('Hitilafu imetokea'))
})
onBeforeUnmount(() => {
  clearTimers()
  penaltyAudio.stopAll()
})
</script>

<template>
  <div class="pb" data-testid="penalty-page" data-penalty-phase :data-phase="phase">
    <p v-if="toast" class="pb-toast" data-testid="penalty-error">{{ toast }}</p>

    <div v-if="intro" class="pb-cover">
      <video :src="ASSET.intro" autoplay muted playsinline class="pb-fill" @ended="intro = false" />
      <div class="pb-intro-shade" />
      <div class="pb-intro-title">
        <div class="pb-word">PENALTY</div>
        <div class="pb-live">Betstapro Live</div>
      </div>
      <button type="button" class="pb-skip" data-testid="penalty-skip-intro" @click="intro = false">RUKA ›</button>
    </div>

    <div v-if="videoOutcome" class="pb-cover pb-fade">
      <video
        ref="videoEl"
        :src="videoSrc"
        autoplay
        muted
        playsinline
        class="pb-fill"
        :style="{ filter: replay === 'replay' ? 'contrast(1.12) saturate(1.15)' : 'none', transform: side === 'left' ? 'scaleX(-1)' : 'none' }"
        @ended="onVideoEnded"
        @error="reveal"
      />
      <div class="pb-letter top" />
      <div class="pb-letter bottom" />
      <div class="pb-vignette" />
      <div class="pb-video-shade" />
      <div class="pb-video-badges">
        <span v-if="replay === 'live'" class="pb-live-pill"><i />LIVE</span>
        <span v-else class="pb-replay-pill"><i />REPLAY</span>
        <span class="pb-tag">{{ replay === 'live' ? 'PENALTY' : 'SLOW MOTION' }}</span>
      </div>
      <div class="pb-tv">BETSTAPRO TV</div>
      <div class="pb-video-caption">
        <div class="pb-big" :class="{ win: videoOutcome === 'goal' }">{{ videoOutcome === 'goal' ? 'GOAL!' : videoOutcome === 'saved' ? 'SAVED!' : 'MISS!' }}</div>
        <div class="pb-sub">{{ replay === 'live' ? 'Penalty Shootout' : 'Marudio · Slow Motion' }}</div>
      </div>
      <button type="button" class="pb-skip low" data-testid="penalty-skip" @click="reveal">RUKA ›</button>
    </div>

    <header class="pb-head">
      <button type="button" class="pb-icon" aria-label="Rudi" @click="router.push('/casino')">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" /></svg>
      </button>
      <div class="pb-brand">
        <span>BETSTAPRO</span>
        <small>Penalty Casino</small>
      </div>
      <div class="pb-tools">
        <div class="pb-pill"><span class="pb-coin" />TZS {{ money(balance) }}</div>
        <button type="button" class="pb-icon" aria-label="Sauti" @click="soundOpen = true">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 10v4h4l5 4V6L8 10H4zM16 9a4 4 0 010 6" fill="none" stroke="currentColor" stroke-width="2" /></svg>
        </button>
        <button type="button" class="pb-icon" aria-label="Historia" data-testid="penalty-history-open" @click="historyOpen = !historyOpen">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 12a9 9 0 109-9 9 9 0 00-7 3M3 4v5h5" fill="none" stroke="currentColor" stroke-width="2" /><path d="M12 7v6l4 2" fill="none" stroke="currentColor" stroke-width="2" /></svg>
        </button>
      </div>
    </header>

    <div class="pb-pitch">
      <video :src="ASSET.intro" autoplay muted loop playsinline class="pb-fill dim" />
      <div class="pb-stage" :style="{ transform: `translate(-50%, -50%) scale(${pitchScale})` }">
        <img :src="ASSET.stadium" alt="Uwanja wa mpira - mechi ya usiku" class="pb-fill" width="1024" height="1536" />
        <div class="pb-stage-shade" />
        <div class="pb-goal">
          <div
            class="pb-keeper"
            :class="{ front: keeperZone === selected && phase !== 'idle' }"
            :style="{ left: `${keeperPoint.x}%`, top: `${keeperPoint.y}%`, width: keeperSide === 'center' ? '30%' : '52%' }"
          >
            <img :src="keeperSrc" alt="Kipa" />
          </div>
          <button
            v-for="key in ORDER"
            v-show="zoneByKey(key)"
            :key="key"
            type="button"
            class="pb-zone"
            :disabled="phase !== 'idle'"
            :style="{ left: `${AIM[key].x}%`, top: `${AIM[key].y}%` }"
            :aria-label="`${zoneByKey(key)?.label ?? key} ${zoneByKey(key)?.multiplier ?? ''}x`"
            :data-testid="`penalty-zone-${key}`"
            @click="selected = key"
          >
            <span class="pb-ring" :class="{ on: selected === key }" />
            <span class="pb-mult" :class="{ on: selected === key }">{{ Number(zoneByKey(key)?.multiplier) }}x</span>
          </button>
          <img
            v-if="ball"
            :src="ASSET.ball"
            alt="Mpira"
            class="pb-flight"
            :class="{ move: ballMoves }"
            :style="{ left: `${ball.x}%`, top: `${ball.y}%` }"
          />
        </div>
        <img v-if="!ball" :src="ASSET.ball" alt="Mpira" class="pb-spot" :class="{ kick: kicking }" />
        <img :src="kicking ? ASSET.kick : ASSET.stand" alt="Mchezaji" class="pb-player" :style="{ left: kicking ? '46%' : '38%' }" />
      </div>

      <div class="pb-live-chip"><i />LIVE <span>PENALTI</span></div>
      <div class="pb-rail">
        <div class="pb-rail-track">
          <div class="pb-rail-fill" :style="{ width: railWidth }" />
          <div class="pb-rail-dots">
            <span v-for="item in rail" :key="item.key" :class="{ on: selected === item.key }" />
          </div>
          <div class="pb-rail-labels">
            <span v-for="item in rail" :key="`${item.key}-l`" :class="{ on: selected === item.key }">x{{ item.multiplier }}</span>
          </div>
        </div>
      </div>

      <div v-if="phase === 'result' && result" class="pb-card-wrap">
        <div class="pb-card" :class="{ win: result.outcome === 'goal' }" data-testid="penalty-result" :data-outcome="result.outcome">
          <template v-if="result.outcome === 'goal'">
            <div class="pb-card-title win">GOAL! ⚽</div>
            <div class="pb-card-mult">{{ result.multiplier }}x</div>
            <div class="pb-card-pay">TZS {{ money(result.payoutTzs) }}</div>
          </template>
          <template v-else>
            <div class="pb-card-title lose">{{ result.outcome === 'saved' ? 'SAVED! 🧤' : 'MISS!' }}</div>
            <div class="pb-lost">STAKE LOST</div>
            <div class="pb-card-stake">TZS {{ money(result.stakeTzs) }}</div>
          </template>
        </div>
      </div>
    </div>

    <div class="pb-dock">
      <div class="pb-row">
        <div class="pb-field">
          <div class="pb-label">Bet</div>
          <div class="pb-stepper">
            <button type="button" data-testid="penalty-stake-dec" @click="nudge(-500)">−</button>
            <input
              v-model.number="stakeTzs"
              data-testid="penalty-stake"
              type="number"
              @blur="stakeTzs = clampStake(stakeTzs || minStake)"
            />
            <button type="button" data-testid="penalty-stake-inc" @click="nudge(500)">+</button>
          </div>
        </div>
        <button v-if="phase === 'result'" type="button" class="pb-again" @click="again">PLAY<br>AGAIN</button>
        <button v-else type="button" class="pb-shoot" data-testid="penalty-shoot" :disabled="phase === 'shooting' || !selected" @click="shoot">
          <span v-if="phase === 'shooting'" class="pb-spin" />
          <span v-else class="pb-ball">⚽</span>
          {{ phase === 'shooting' ? 'PIGA...' : 'SHOOT' }}
        </button>
        <div class="pb-field">
          <div class="pb-label">Balance</div>
          <div class="pb-balance">TZS {{ money(balance) }}</div>
        </div>
      </div>
      <div class="pb-chips">
        <div>
          <button
            v-for="chip in chips"
            :key="chip"
            type="button"
            :data-testid="`penalty-chip-${chip}`"
            :class="{ on: stakeTzs === chip }"
            @click="stakeTzs = clampStake(chip)"
          >{{ chipLabel(chip) }}</button>
        </div>
        <div class="pb-win">Win: <b>TZS {{ money(potential) }}</b></div>
      </div>
    </div>

    <div v-if="historyOpen" class="pb-sheet" data-testid="penalty-history" @click="historyOpen = false">
      <div class="pb-sheet-card" @click.stop>
        <div class="pb-sheet-title">Historia ya Penalti</div>
        <p v-if="!history.length" class="pb-empty">Bado hujacheza penalti.</p>
        <div v-for="shot in history" :key="shot.id" class="pb-hist" data-testid="penalty-history-row">
          <div>
            <b>Penalty #{{ shot.nonce + 1 }}</b>
            <div>Stake: TZS {{ money(shot.stakeTzs) }}</div>
          </div>
          <div class="pb-hist-out">
            <b :class="{ win: shot.outcome === 'goal' }">{{ shot.outcome === 'goal' ? `${Number(shot.multiplier)}x` : shot.outcome === 'saved' ? 'Saved' : 'Miss' }}</b>
            <div>{{ shot.outcome === 'goal' ? `+TZS ${money(shot.payoutTzs)}` : `−TZS ${money(shot.stakeTzs)}` }}</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="soundOpen" class="pb-sheet high" @click="soundOpen = false">
      <div class="pb-sheet-card" @click.stop>
        <div class="pb-sheet-title">Sauti (Audio)</div>
        <div v-for="row in [
          { key: 'commentaryOn', vol: 'commentaryVol', label: 'Commentary' },
          { key: 'stadiumOn', vol: 'stadiumVol', label: 'Stadium' },
          { key: 'effectsOn', vol: 'effectsVol', label: 'Effects' },
        ]" :key="row.key" class="pb-sound">
          <div class="pb-sound-line">
            <span>{{ row.label }}</span>
            <button type="button" :class="{ on: sound[row.key as keyof PenaltyAudioSettings] }" @click="patchSound({ [row.key]: !sound[row.key as keyof PenaltyAudioSettings] })">
              {{ sound[row.key as keyof PenaltyAudioSettings] ? 'ON' : 'OFF' }}
            </button>
          </div>
          <div class="pb-sound-line">
            <input
              type="range"
              min="0"
              max="100"
              :aria-label="`${row.label} volume`"
              :value="Math.round(Number(sound[row.vol as keyof PenaltyAudioSettings]) * 100)"
              @input="patchSound({ [row.vol]: Number(($event.target as HTMLInputElement).value) / 100 })"
            />
            <span>{{ Math.round(Number(sound[row.vol as keyof PenaltyAudioSettings]) * 100) }}%</span>
          </div>
        </div>
        <button type="button" class="pb-ok" @click="soundOpen = false">SAWA</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pb{position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;background:#05130b;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.pb button{font-family:inherit;cursor:pointer}
.pb-toast{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:80;background:#111;border:1px solid #b8ff00;color:#fff;border-radius:12px;padding:10px 14px;max-width:90%;text-align:center;font-size:13px}
.pb-cover{position:absolute;inset:0;z-index:60;background:#000}
.pb-fade{animation:pb-fade .25s ease}
.pb-fill{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.pb-fill.dim{opacity:.4}
.pb-intro-shade{position:absolute;inset:0;background:linear-gradient(#0008,transparent 40%,#000c)}
.pb-intro-title{position:absolute;left:0;right:0;bottom:96px;display:flex;flex-direction:column;align-items:center;gap:8px}
.pb-word{font-size:30px;font-weight:900;letter-spacing:.2em;color:#b8ff00;text-shadow:0 2px 10px #000}
.pb-live{font-size:11px;letter-spacing:.35em;text-transform:uppercase;color:#ffffffb3}
.pb-skip{position:absolute;top:16px;right:16px;border-radius:999px;background:#0009;border:1px solid #ffffff40;color:#fff;padding:6px 12px;font-size:11px;font-weight:700}
.pb-skip.low{top:auto;bottom:8%;right:12px}
.pb-letter{position:absolute;left:0;right:0;height:6%;background:#000}
.pb-letter.top{top:0}.pb-letter.bottom{bottom:0}
.pb-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 45%,#000000b8 100%)}
.pb-video-shade{position:absolute;inset:0;background:linear-gradient(#00000059,transparent 40%,#000b)}
.pb-video-badges{position:absolute;left:12px;top:9%;display:flex;gap:8px;align-items:center}
.pb-live-pill,.pb-replay-pill{display:flex;align-items:center;gap:6px;border-radius:6px;padding:4px 8px;font-size:10px;font-weight:900;letter-spacing:.12em}
.pb-live-pill{background:#dc2626;color:#fff}.pb-replay-pill{background:#b8ff00;color:#04240f}
.pb-live-pill i,.pb-replay-pill i,.pb-live-chip i{width:6px;height:6px;border-radius:50%;background:#fff;display:inline-block;animation:pb-pulse 1s infinite}
.pb-replay-pill i{background:#04240f}
.pb-tag{border-radius:6px;background:#000a;border:1px solid #ffffff33;padding:4px 8px;font-size:10px;font-weight:700;letter-spacing:.18em}
.pb-tv{position:absolute;right:12px;top:9%;border-radius:6px;background:#0009;border:1px solid #ffffff26;padding:4px 8px;font-size:9px;font-weight:900;letter-spacing:.25em;color:#b8ff00}
.pb-video-caption{position:absolute;left:0;right:0;bottom:14%;display:flex;flex-direction:column;align-items:center;gap:8px}
.pb-big{font-size:48px;font-weight:900;letter-spacing:.12em;color:#f87171;text-shadow:0 3px 14px #000}
.pb-big.win{color:#b8ff00}
.pb-sub{font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#ffffffb3}
.pb-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:#04240f;border-bottom:1px solid #0b5c28}
.pb-icon{background:transparent;border:0;color:#fff;padding:6px;border-radius:6px}
.pb-brand{display:flex;flex-direction:column;align-items:center;line-height:1}
.pb-brand span{font-size:11px;font-weight:900;letter-spacing:.18em;color:#b8ff00}
.pb-brand small{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#fff9}
.pb-tools{display:flex;align-items:center;gap:8px}
.pb-pill,.pb-balance,.pb-stepper{display:flex;align-items:center;gap:4px;background:#0006;border:1px solid #0b5c28;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:700}
.pb-coin{width:8px;height:8px;border-radius:50%;background:#b8ff00}
.pb-pitch{position:relative;flex:1;min-height:0;overflow:hidden;background:#000}
.pb-stage{position:absolute;left:50%;top:50%;width:100%;aspect-ratio:1024/1536;transition:transform 900ms cubic-bezier(.2,.8,.3,1)}
.pb-stage-shade{position:absolute;inset:0;background:linear-gradient(#00000040,transparent 40%,#00000073)}
.pb-goal{position:absolute;left:20%;top:38.2%;width:60%;height:15.5%}
.pb-keeper{position:absolute;z-index:10;transform:translate(-50%,-50%);transition:all .5s ease-out;pointer-events:none}
.pb-keeper.front{z-index:40}
.pb-keeper img,.pb-flight,.pb-spot,.pb-player{filter:drop-shadow(0 8px 10px #0009)}
.pb-keeper img{width:100%;height:auto}
.pb-zone{position:absolute;z-index:20;width:13%;aspect-ratio:1;transform:translate(-50%,-50%);border:0;background:transparent;padding:0;border-radius:50%}
.pb-zone:disabled{cursor:default}
.pb-ring{position:absolute;inset:0;border-radius:50%;border:2px solid #fff9;background:#00000040}
.pb-ring.on{border-color:#b8ff00;background:#b8ff0040;box-shadow:0 0 14px #b8ff00cc}
.pb-mult{position:relative;font-size:9px;font-weight:900;color:#ffffffe6;text-shadow:0 1px 2px #000}
.pb-mult.on{color:#b8ff00}
.pb-flight{position:absolute;z-index:30;width:16%;transform:translate(-50%,-50%) rotate(540deg);pointer-events:none}
.pb-flight.move{transition:left .8s cubic-bezier(.2,.8,.3,1),top .8s cubic-bezier(.2,.8,.3,1),transform .8s linear}
.pb-spot{position:absolute;z-index:20;left:50%;top:64%;width:7%;transform:translateX(-50%);pointer-events:none;transition:transform .2s}
.pb-spot.kick{transform:translateX(-50%) scale(.9)}
.pb-player{position:absolute;z-index:20;top:58%;width:20%;transform:translateX(-50%);pointer-events:none;transition:all .2s}
.pb-live-chip{position:absolute;top:8px;left:8px;z-index:20;display:flex;align-items:center;gap:6px;background:#000a;border:1px solid #ffffff26;border-radius:6px;padding:4px 8px;font-size:10px;font-weight:900;letter-spacing:.12em}
.pb-live-chip i{background:#ef4444}
.pb-live-chip span{color:#fff9;font-weight:500;letter-spacing:0}
.pb-rail{position:absolute;top:36px;left:8px;right:8px;z-index:20}
.pb-rail-track{position:relative;flex:1;height:6px;border-radius:999px;background:#ffffff40;margin:10px 8px 22px}
.pb-rail{display:flex}
.pb-rail > div{flex:1;background:#00000073;border:1px solid #ffffff26;border-radius:999px;padding:6px 8px;backdrop-filter:blur(8px)}
.pb-rail-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:#b8ff00}
.pb-rail-dots,.pb-rail-labels{position:absolute;left:0;right:0;display:flex;justify-content:space-between;padding:0 4px}
.pb-rail-dots{top:-3px}
.pb-rail-dots span{width:8px;height:8px;border-radius:50%;background:#ffffffb3}
.pb-rail-dots span.on{background:#b8ff00}
.pb-rail-labels{top:12px;font-size:10px;font-weight:600}
.pb-rail-labels span.on{color:#b8ff00}
.pb-card-wrap{position:absolute;left:0;right:0;top:20%;display:flex;justify-content:center;z-index:30;padding:0 16px}
.pb-card{border-radius:16px;padding:12px 20px;text-align:center;background:#000c;border:1px solid #ffffff33;animation:pb-pop .25s ease}
.pb-card.win{background:#04240fe6;border-color:#b8ff00;box-shadow:0 0 28px #b8ff0059}
.pb-card-title{font-size:24px;font-weight:900;letter-spacing:.06em}
.pb-card-title.win,.pb-card-pay,.pb-hist b.win{color:#b8ff00}
.pb-card-title.lose,.pb-hist-out b{color:#f87171}
.pb-card-mult{font-size:30px;font-weight:900}
.pb-card-pay{font-size:14px;font-weight:700;margin-top:4px}
.pb-lost{font-size:11px;color:#fff9;margin-top:4px}
.pb-card-stake{font-weight:700}
.pb-dock{background:#04240ff2;border-top:1px solid #0b5c28;padding:8px 12px calc(12px + env(safe-area-inset-bottom))}
.pb-row{display:flex;align-items:flex-end;gap:8px}
.pb-field{flex:1;min-width:0}
.pb-label{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#fff8;text-align:center}
.pb-stepper{padding:4px 6px}
.pb-stepper button{width:28px;height:28px;border-radius:50%;border:0;background:#ffffff1a;color:#fff;font-weight:700;padding:0}
.pb-stepper input{flex:1;min-width:0;height:28px;background:transparent;border:0;color:#fff;text-align:center;font-weight:900;font-size:14px;width:auto;margin:0;padding:0}
.pb-balance{justify-content:center;padding:6px 8px;font-size:14px;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-shoot,.pb-again{width:86px;height:62px;flex:0 0 auto;border:0;border-radius:16px;background:linear-gradient(#b8ff00,#7fbe00);color:#04240f;font-weight:900;font-size:13px}
.pb-again{background:#b8ff00;font-size:11px;line-height:1.15}
.pb-shoot:disabled{opacity:.4}
.pb-ball{display:block;font-size:18px;line-height:1}
.pb-spin{width:18px;height:18px;border:2px solid #04240f;border-top-color:transparent;border-radius:50%;display:inline-block;animation:pb-spin .7s linear infinite}
.pb-chips{margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.pb-chips > div{display:flex;gap:6px;flex-wrap:wrap}
.pb-chips button{padding:4px 10px;border-radius:999px;border:1px solid #ffffff26;background:#ffffff0d;color:#fffc;font-size:10px;font-weight:700}
.pb-chips button.on{background:#b8ff00;color:#04240f;border-color:#b8ff00}
.pb-win{font-size:10px;color:#fff9;white-space:nowrap}
.pb-win b{color:#b8ff00}
.pb-sheet{position:absolute;inset:0;z-index:70;background:#000000b3;backdrop-filter:blur(4px)}
.pb-sheet-card{position:absolute;left:0;right:0;bottom:0;max-height:70%;overflow:auto;background:#04240f;border-top:1px solid #0b5c28;border-radius:16px 16px 0 0;padding:12px 12px calc(16px + env(safe-area-inset-bottom))}
.pb-sheet-title{font-size:14px;font-weight:700;margin-bottom:8px}
.pb-empty{text-align:center;color:#fff8;font-size:12px;padding:24px 0}
.pb-hist{display:flex;justify-content:space-between;background:#ffffff0d;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:6px}
.pb-hist-out{text-align:right;color:#fff9}
.pb-sound{margin-bottom:12px}
.pb-sound-line{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px}
.pb-sound-line button{border-radius:999px;padding:4px 12px;font-size:10px;font-weight:900;border:1px solid #ffffff33;background:#ffffff0d;color:#fff9}
.pb-sound-line button.on{background:#b8ff00;color:#04240f;border-color:#b8ff00}
.pb-sound-line input{flex:1;accent-color:#b8ff00}
.pb-ok{width:100%;margin-top:4px;border:0;border-radius:12px;background:#b8ff00;color:#04240f;font-weight:900;padding:10px;font-size:14px}
@keyframes pb-pulse{50%{opacity:.4}}
@keyframes pb-spin{to{transform:rotate(360deg)}}
@keyframes pb-fade{from{opacity:0}to{opacity:1}}
@keyframes pb-pop{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}
</style>
