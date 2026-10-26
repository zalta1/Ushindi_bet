<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

type Reward = {
  id: string
  label: string
  amount: number
  segmentCount: number
  color: string
  isLost: boolean
  displayOrder: number
}
type Limits = {
  enabled: boolean
  spinCost: number
  minStake: number
  maxStake: number
  chips: number[]
}
type Winner = { id: string; rewardLabel: string; amountWon: number; createdAt: string }
type SpinReward = { id: string | null; label: string; color: string; isLost: boolean; amount: number }
type Spin = { id: string; segmentIndex: number; payoutTzs: number; reward: SpinReward }

const CHIPS = [100, 500, 1000, 5000]
const router = useRouter()
const auth = useAuth()
const rewards = ref<Reward[]>([])
const winners = ref<Winner[]>([])
const limits = ref<Limits>({ enabled: true, spinCost: 500, minStake: 100, maxStake: 100_000, chips: CHIPS })
const stake = ref('500')
const shown = ref(0)
const rotation = ref(0)
const phase = ref<'idle' | 'spinning' | 'result'>('idle')
const result = ref<Spin | null>(null)
const modal = ref(false)
const toast = ref('')

let audio: AudioContext | null = null
let tickTimer = 0
let revealTimer = 0
let toastTimer = 0
let pendingBalance = 0

const segments = computed(() => {
  const list: { reward: Reward }[] = []
  for (const reward of rewards.value) {
    for (let i = 0; i < reward.segmentCount; i += 1) list.push({ reward })
  }
  return list
})
const slice = computed(() => (segments.value.length ? 360 / segments.value.length : 0))
const prizes = computed(() => rewards.value.filter((reward) => !reward.isLost))
const spinning = computed(() => phase.value === 'spinning')

function ve(value: number) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function show(message: string, ms = 4000) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = '' }, ms)
}
function context() {
  if (!audio) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctx) audio = new Ctx()
  }
  if (audio?.state === 'suspended') void audio.resume()
  return audio
}
function beep(freq = 800, duration = 0.05, gain = 0.15) {
  const ctx = audio
  if (!ctx) return
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  amp.gain.setValueAtTime(gain, ctx.currentTime)
  amp.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
  osc.connect(amp).connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + duration)
}
function winChime() {
  ;[523, 659, 784, 1046].forEach((freq, index) => window.setTimeout(() => beep(freq, 0.2, 0.2), index * 110))
}
function loseChime() {
  ;[300, 220, 160].forEach((freq, index) => window.setTimeout(() => beep(freq, 0.25, 0.15), index * 140))
}
function stopTicks() {
  window.clearTimeout(tickTimer)
  tickTimer = 0
}
function startTicks() {
  stopTicks()
  let elapsed = 0
  const total = 5000
  let delay = 60
  const step = () => {
    if (elapsed >= total) { stopTicks(); return }
    beep(900, 0.03, 0.12)
    elapsed += delay
    delay = 60 + (elapsed / total) * 280
    tickTimer = window.setTimeout(step, delay)
  }
  step()
}
function wedge(index: number) {
  const sweep = slice.value
  const start = index * sweep - 90 - sweep / 2
  const end = start + sweep
  const rad = (deg: number) => (deg * Math.PI) / 180
  const x1 = 100 * Math.cos(rad(start))
  const y1 = 100 * Math.sin(rad(start))
  const x2 = 100 * Math.cos(rad(end))
  const y2 = 100 * Math.sin(rad(end))
  const large = sweep > 180 ? 1 : 0
  const labelAngle = index * sweep - 90
  return {
    d: `M 0 0 L ${x1} ${y1} A 100 100 0 ${large} 1 ${x2} ${y2} Z`,
    x: 62 * Math.cos(rad(labelAngle)),
    y: 62 * Math.sin(rad(labelAngle)),
    rotate: labelAngle + 90,
  }
}
function labelOf(reward: Reward) {
  return reward.isLost ? 'LOST' : reward.label
}
function fontOf(text: string) {
  return text.length > 8 ? 7 : text.length > 5 ? 9 : 11
}

async function load() {
  const data = await api<{ limits: Limits; rewards: Reward[]; winners: Winner[] }>('/api/zungusha')
  limits.value = data.limits
  rewards.value = data.rewards
  winners.value = data.winners
  stake.value = String(data.limits.spinCost)
}

function reveal(spin: Spin) {
  stopTicks()
  phase.value = 'result'
  result.value = spin
  modal.value = true
  shown.value = pendingBalance
  if (auth.user) auth.user.balanceTzs = pendingBalance
  if (spin.reward.isLost) loseChime()
  else {
    winChime()
    show(`🎉 Umeshinda ${ve(spin.reward.amount)} TSh!`)
    winners.value = [{
      id: spin.id,
      rewardLabel: spin.reward.label,
      amountWon: spin.reward.amount,
      createdAt: new Date().toISOString(),
    }, ...winners.value].slice(0, 10)
  }
}
function closeModal() {
  modal.value = false
  if (phase.value === 'result') phase.value = 'idle'
}

async function spin() {
  if (phase.value === 'spinning') return
  const amount = Math.floor(Number(stake.value))
  const min = limits.value.minStake
  const max = limits.value.maxStake
  if (!auth.user) { show('Ingia kwanza'); return }
  if (!amount || amount < min || amount > max) { show(`Kias kati ya ${min} na ${ve(max)} TSh`); return }
  if (shown.value < amount) { show('Salio haitoshi. Weka pesa kwanza.'); return }
  if (!segments.value.length) { show('Tuzo hazipatikani'); return }
  if (shown.value >= 10_000_000) {
    show('Salio lako limefikia kikomo cha TSH 10,000,000. Tafadhali toa pesa zako kwanza ili uendelee kucheza. Account haiwezi kuwa na zaidi ya TSH 10,000,000.', 7000)
    return
  }
  if (!limits.value.enabled) { show('Mchezo umezimwa'); return }
  context()
  phase.value = 'spinning'
  result.value = null
  modal.value = false
  try {
    const response = await api<{ balanceTzs: number; spin: Spin }>('/api/zungusha/spin', {
      method: 'POST',
      json: { stakeTzs: amount, idempotencyKey: crypto.randomUUID() },
    })
    pendingBalance = response.balanceTzs
    if (auth.user) auth.user.balanceTzs = response.balanceTzs
    const count = segments.value.length
    const sweep = 360 / count
    // The slice center is index * sweep clockwise from the top. The published
    // client adds half a slice and stops on the boundary. This stops with the
    // winning label under the pointer.
    const center = response.spin.segmentIndex * sweep
    const target = (360 - center) % 360
    const current = ((rotation.value % 360) + 360) % 360
    const delta = (target - current + 360) % 360
    rotation.value = rotation.value + 6 * 360 + delta
    startTicks()
    window.clearTimeout(revealTimer)
    revealTimer = window.setTimeout(() => reveal(response.spin), 5200)
  } catch (err) {
    phase.value = 'idle'
    stopTicks()
    if (err instanceof ApiClientError) {
      if (err.code === 'insufficient_funds') show('Salio haitoshi. Weka pesa kwanza.')
      else if (err.code === 'game_disabled') show('Mchezo umezimwa')
      else if (err.code === 'unauthenticated') show('Ingia kwanza')
      else if (err.code === 'no_rewards') show('Tuzo hazipatikani')
      else show('Spin imeshindwa')
    } else show('Hitilafu')
  }
}

watch(() => auth.user?.balanceTzs, (value) => {
  if (phase.value !== 'spinning' && typeof value === 'number') shown.value = value
}, { immediate: true })

onMounted(() => { void load() })
onUnmounted(() => {
  stopTicks()
  window.clearTimeout(revealTimer)
  window.clearTimeout(toastTimer)
  void audio?.close()
})
</script>

<template>
  <div class="zg" data-testid="zungusha-page" :data-phase="phase">
    <p v-if="toast" class="zg-toast" data-testid="zungusha-toast">{{ toast }}</p>
    <div class="zg-orbs" aria-hidden="true">
      <span class="orb purple" />
      <span class="orb pink" />
      <span class="orb yellow" />
    </div>
    <header class="zg-bar">
      <button type="button" class="zg-back" @click="router.push('/casino')">‹ Rudi</button>
      <div class="zg-brand">
        <div class="zg-eye">ZUNGUSHA</div>
        <div class="zg-title">SHINDA</div>
      </div>
      <div class="zg-balance"><span class="coin" />{{ ve(shown) }}</div>
    </header>
    <div class="zg-col">
      <div class="zg-stage">
        <div class="zg-ring">
          <div class="zg-ring-inner">
            <div class="zg-bulbs" aria-hidden="true">
              <div v-for="i in 24" :key="i" class="zg-bulb" :style="{ transform: `translate(-50%, -50%) rotate(${((i - 1) / 24) * 360}deg) translateY(-49%)` }">
                <span :class="(i - 1) % 2 === 0 ? 'even' : 'odd'" />
              </div>
            </div>
            <div
              class="zg-rotor"
              data-testid="zungusha-wheel"
              :style="{ transform: `rotate(${rotation}deg)`, transition: spinning ? 'transform 5s cubic-bezier(0.17, 0.67, 0.16, 1.01)' : 'none' }"
            >
              <svg viewBox="-100 -100 200 200">
                <g v-for="(segment, index) in segments" :key="index">
                  <path :d="wedge(index).d" :fill="segment.reward.color" stroke="#000" stroke-width="0.6" />
                  <g :transform="`rotate(${wedge(index).rotate} ${wedge(index).x} ${wedge(index).y})`">
                    <text
                      :x="wedge(index).x"
                      :y="wedge(index).y"
                      :fill="segment.reward.isLost ? '#bbb' : '#fff'"
                      :font-size="fontOf(labelOf(segment.reward))"
                      font-weight="900"
                      text-anchor="middle"
                      dominant-baseline="middle"
                    >{{ labelOf(segment.reward) }}</text>
                  </g>
                </g>
              </svg>
            </div>
            <button type="button" class="zg-hub" :disabled="spinning" data-testid="zungusha-hub" @click="spin">
              <span>{{ spinning ? '...' : 'ZUNGUSHA' }}</span>
            </button>
          </div>
        </div>
        <div class="zg-pointer" aria-hidden="true">
          <svg width="32" height="40" viewBox="0 0 32 40">
            <defs>
              <linearGradient id="zgPointer" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#fde047" />
                <stop offset="100%" stop-color="#ea580c" />
              </linearGradient>
            </defs>
            <path d="M 16 38 L 4 8 Q 16 0 28 8 Z" fill="url(#zgPointer)" stroke="#7c2d12" stroke-width="1.5" />
            <circle cx="16" cy="10" r="3" fill="#fde047" />
          </svg>
        </div>
      </div>

      <div class="zg-card">
        <div class="zg-card-head">
          <label>KIAS CHA KUWEKA</label>
          <span>Min {{ limits.minStake }} · Max {{ ve(limits.maxStake) }}</span>
        </div>
        <div class="zg-stake">
          <input
            v-model="stake"
            data-testid="zungusha-stake"
            type="number"
            inputmode="numeric"
            :disabled="spinning"
            :placeholder="String(limits.spinCost)"
          />
          <b>TSh</b>
        </div>
        <div class="zg-chips">
          <button
            v-for="chip in limits.chips"
            :key="chip"
            type="button"
            :data-testid="`zungusha-chip-${chip}`"
            :class="{ on: Number(stake) === chip }"
            :disabled="spinning"
            @click="stake = String(chip)"
          >{{ ve(chip) }}</button>
        </div>
      </div>

      <button type="button" class="zg-go" data-testid="zungusha-spin" :disabled="spinning || shown < Number(stake || 0)" @click="spin">
        {{ spinning ? 'INAZUNGUKA...' : `ZUNGUSHA · ${ve(Number(stake || 0))} TSh` }}
      </button>
      <div class="zg-steps">
        <span class="step"><svg viewBox="0 0 24 24" class="ico gold"><path d="M21 12a9 9 0 1 1-2.2-5.8M21 4v5h-5" /></svg>ZUNGUSHA</span>
        <span>›</span>
        <span class="step"><svg viewBox="0 0 24 24" class="ico pink"><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>SUBIRI</span>
        <span>›</span>
        <span class="step"><svg viewBox="0 0 24 24" class="ico green"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM5 4h14" /></svg>SHINDA</span>
      </div>

      <div class="zg-card prizes">
        <div class="zg-label">ZAWADI KUBWA</div>
        <div class="zg-prize-grid">
          <div v-for="reward in prizes" :key="reward.id" class="zg-prize" data-testid="zungusha-prize" :style="{ borderColor: reward.color + '80', boxShadow: `0 0 12px ${reward.color}40` }">
            <b :style="{ color: reward.color }">{{ reward.label }}</b>
            <small v-if="reward.amount > 0">TSh</small>
          </div>
        </div>
      </div>

      <div v-if="winners.length" class="zg-card winners">
        <div class="zg-label pink">WASHINDI WA HIVI KARIBUNI</div>
        <div class="zg-winner-list">
          <div v-for="row in winners" :key="row.id" class="zg-winner" data-testid="zungusha-winner">
            <span>🎉 {{ row.rewardLabel }}</span>
            <b>+{{ ve(row.amountWon) }}</b>
          </div>
        </div>
      </div>
    </div>

    <div v-if="modal && result" class="zg-modal" @click="closeModal">
      <div
        class="zg-modal-card"
        data-testid="zungusha-result"
        :data-outcome="result.reward.isLost ? 'loss' : 'win'"
        :style="{ borderColor: result.reward.isLost ? '#666' : result.reward.color, boxShadow: `0 0 60px ${result.reward.isLost ? '#666' : result.reward.color}80` }"
        @click.stop
      >
        <template v-if="result.reward.isLost">
          <div class="zg-emoji">😔</div>
          <div class="zg-lost-title">SAFARI HII...</div>
          <p>Bahati haijakuangukia. Jaribu tena!</p>
        </template>
        <template v-else>
          <div class="zg-emoji">🎉</div>
          <div class="zg-win-title">UMESHINDA!</div>
          <div class="zg-win-label">{{ result.reward.label }}</div>
          <p class="zg-win-pay">+{{ ve(result.reward.amount) }} TSh imeingia kwenye wallet</p>
        </template>
        <button type="button" class="zg-continue" data-testid="zungusha-continue" @click="closeModal">ENDELEA</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zg{position:fixed;inset:0;z-index:30;overflow:auto;color:#fff;background:linear-gradient(#0a0420,#1a0a3a,#0a0420);font-family:system-ui,sans-serif}
.zg-toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:60;background:#111;color:#fde047;border:1px solid rgba(250,204,21,.45);border-radius:12px;padding:10px 14px;max-width:min(420px,92vw);text-align:center;font-weight:700}
.zg-orbs{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.orb{position:absolute;border-radius:50%;filter:blur(48px)}
.orb.purple{top:-160px;left:-160px;width:384px;height:384px;background:rgba(147,51,234,.2)}
.orb.pink{bottom:-160px;right:-160px;width:384px;height:384px;background:rgba(219,39,119,.2)}
.orb.yellow{top:33%;left:50%;width:500px;height:500px;transform:translateX(-50%);background:rgba(234,179,8,.1)}
.zg-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;background:rgba(0,0,0,.4);border-bottom:1px solid rgba(168,85,247,.3);backdrop-filter:blur(12px)}
.zg-back{background:transparent;border:0;color:#e9d5ff;font-size:14px;padding:0;cursor:pointer}
.zg-brand{text-align:center}
.zg-eye{font-size:10px;letter-spacing:.3em;font-weight:700;color:rgba(253,224,71,.8)}
.zg-title{font-size:16px;font-weight:900;letter-spacing:.15em;background:linear-gradient(90deg,#fde047,#f472b6,#c084fc);-webkit-background-clip:text;background-clip:text;color:transparent}
.zg-balance{display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.5);border:1px solid rgba(234,179,8,.4);border-radius:999px;padding:6px 12px;color:#fde047;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.coin{width:14px;height:14px;border-radius:50%;background:#facc15;box-shadow:0 0 8px rgba(250,204,21,.8)}
.zg-col{position:relative;z-index:1;max-width:28rem;margin:0 auto;padding:16px 12px 28px;display:flex;flex-direction:column;gap:16px}
.zg-stage{position:relative;width:100%;aspect-ratio:1}
.zg-ring{position:absolute;inset:0;border-radius:50%;padding:5px;background:linear-gradient(to bottom right,#facc15,#f97316,#ca8a04);box-shadow:0 0 60px rgba(250,204,21,.5)}
.zg-ring-inner{position:relative;width:100%;height:100%;border-radius:50%;background:#0a0420;padding:3px}
.zg-bulbs{position:absolute;inset:0;border-radius:50%;pointer-events:none}
.zg-bulb{position:absolute;top:50%;left:50%}
.zg-bulb span{display:block;width:8px;height:8px;border-radius:50%;box-shadow:0 0 8px rgba(253,224,71,.9)}
.zg-bulb span.even{background:#fde047;animation:zg-pulse 1.2s ease-in-out infinite}
.zg-bulb span.odd{background:#fb923c;animation:zg-pulse 1.5s ease-in-out infinite}
.zg-rotor{position:absolute;inset:14px;border-radius:50%;overflow:hidden}
.zg-rotor svg{width:100%;height:100%;display:block}
.zg-rotor text{paint-order:stroke;stroke:#000;stroke-width:.8}
.zg .zg-hub{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:26%;height:26%;border-radius:50%;border:0;padding:3px;z-index:10;cursor:pointer;background:linear-gradient(to bottom right,#fde047,#f97316,#a16207);box-shadow:0 0 30px rgba(250,204,21,.8)}
.zg .zg-hub:disabled{opacity:.8}
.zg-hub span{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:linear-gradient(#3a1f0a,#1a0a02);border:2px solid rgba(202,138,4,.5);color:#fde047;font-weight:900;font-size:11px;letter-spacing:.15em;text-shadow:0 0 8px rgba(253,224,71,.9)}
.zg-pointer{position:absolute;top:-8px;left:50%;transform:translateX(-50%);z-index:20}
.zg-card{background:rgba(0,0,0,.4);border:1px solid rgba(234,179,8,.3);border-radius:16px;padding:12px;backdrop-filter:blur(6px)}
.zg-card.prizes{border-color:rgba(168,85,247,.3)}
.zg-card.winners{border-color:rgba(236,72,153,.3)}
.zg-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.zg-card-head label,.zg-label{font-size:12px;font-weight:700;letter-spacing:.15em;color:#fde047}
.zg-card-head span{font-size:10px;color:rgba(255,255,255,.5)}
.zg-label.pink{color:#f9a8d4;margin-bottom:8px}
.zg-stake{display:flex;align-items:center;gap:8px}
.zg-stake input{flex:1;width:auto;margin:0;background:rgba(0,0,0,.6);border:1px solid rgba(234,179,8,.4);border-radius:12px;padding:10px 12px;font-size:18px;font-weight:700;color:#fde047;font-variant-numeric:tabular-nums}
.zg-stake input:focus{outline:none;border-color:#facc15}
.zg-stake input:disabled{opacity:.6}
.zg-stake b{color:#facc15;font-size:14px}
.zg-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.zg .zg-chips button{padding:6px 0;border-radius:8px;font-size:12px;font-weight:700;background:rgba(0,0,0,.5);color:#fef08a;border:1px solid rgba(234,179,8,.3);cursor:pointer}
.zg .zg-chips button.on{background:#facc15;color:#000;border-color:#fde047}
.zg .zg-chips button:disabled{opacity:.6}
.zg .zg-go{width:100%;padding:16px;border:0;border-radius:16px;cursor:pointer;background:linear-gradient(90deg,#facc15,#f97316,#eab308);color:#000;font-weight:900;font-size:18px;letter-spacing:.12em;box-shadow:0 0 30px rgba(250,204,21,.5)}
.zg .zg-go:disabled{opacity:.5}
.zg-steps{display:flex;align-items:center;justify-content:center;gap:8px;font-size:10px;color:rgba(233,213,255,.8);letter-spacing:.08em}
.zg-steps .step{display:flex;align-items:center;gap:4px}
.zg-steps .ico{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.zg-steps .gold{color:#facc15}
.zg-steps .pink{color:#f472b6}
.zg-steps .green{color:#4ade80}
.zg-prize-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.zg-prize{background:rgba(0,0,0,.4);border:1px solid;border-radius:8px;padding:8px;text-align:center}
.zg-prize b{display:block;font-size:10px}
.zg-prize small{display:block;margin-top:2px;font-size:9px;color:rgba(255,255,255,.6)}
.zg-winner-list{max-height:192px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.zg-winner{display:flex;align-items:center;justify-content:space-between;font-size:12px;background:rgba(0,0,0,.4);border-radius:8px;padding:6px 10px}
.zg-winner span{color:rgba(255,255,255,.8)}
.zg-winner b{color:#4ade80;font-variant-numeric:tabular-nums}
.zg-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.8);backdrop-filter:blur(6px);padding:16px}
.zg-modal-card{position:relative;max-width:24rem;width:100%;background:linear-gradient(#1a0a3a,#0a0420);border:2px solid;border-radius:24px;padding:24px;text-align:center}
.zg-emoji{font-size:48px;margin-bottom:8px}
.zg-lost-title{font-size:24px;font-weight:900;color:#d1d5db;margin-bottom:4px}
.zg-modal-card p{font-size:14px;color:#9ca3af;margin:0 0 16px}
.zg-win-title{font-size:24px;font-weight:900;margin-bottom:4px;background:linear-gradient(90deg,#fde047,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent}
.zg-win-label{font-size:30px;font-weight:900;margin-bottom:4px}
.zg-win-pay{color:#4ade80;font-weight:700}
.zg .zg-continue{width:100%;padding:12px;border:0;border-radius:12px;cursor:pointer;background:linear-gradient(90deg,#facc15,#f97316);color:#000;font-weight:900;letter-spacing:.12em}
@keyframes zg-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.7)}}
</style>
