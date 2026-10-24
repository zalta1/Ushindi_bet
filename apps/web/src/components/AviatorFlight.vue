<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import planeWebp from '../assets/aviator-plane.webp'
import planePng from '../assets/aviator-plane.png'
import propWebp from '../assets/aviator-prop.webp'
import propPng from '../assets/aviator-prop.png'

const props = defineProps<{
  phase: string
  multiplier: number
  countdownMs: number
  enabled: boolean
  viewerCount: number
  rtpBps: number
}>()

const emit = defineEmits<{ live: [multiplier: number] }>()

const { t } = useI18n()
const skyEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const planeEl = ref<HTMLElement | null>(null)
const label = ref('…')
const crashText = ref('')

/**
 * Public growth curve (the same segments as the server). Used only to
 * interpolate the multiplier between snapshots. It does not know the crash.
 */
const SEGMENTS = [
  { maxM: 1.5, k: 0.07 },
  { maxM: 2, k: 0.07 },
  { maxM: 10, k: 0.08 },
  { maxM: Number.POSITIVE_INFINITY, k: 0.09 },
]

function multiplierAt(seconds: number) {
  let m = 1
  let remaining = Math.max(0, seconds)
  if (remaining <= 0) return 1
  for (let i = 0; i < SEGMENTS.length; i += 1) {
    const segment = SEGMENTS[i]
    const dt = Math.log(segment.maxM / m) / segment.k
    if (remaining <= dt || i === SEGMENTS.length - 1) {
      return Math.max(1, m * Math.exp(segment.k * Math.min(remaining, dt)))
    }
    remaining -= dt
    m = segment.maxM
  }
  return m
}

function secondsFor(mult: number) {
  const target = Math.max(1, mult)
  let t = 0
  let cur = 1
  for (const segment of SEGMENTS) {
    const cap = Math.min(target, segment.maxM)
    if (cap <= cur) break
    t += Math.log(cap / cur) / segment.k
    cur = cap
    if (target <= segment.maxM) break
  }
  return t
}

/** Asymptotic progress in (0, 1). High multipliers approach the edge and never cross it. */
function progress(mult: number) {
  const m = Math.max(1, mult)
  return {
    xT: 1 - m ** -0.42,
    yT: 1 - m ** -0.65,
  }
}

function place(mult: number, width: number, height: number, planeW: number, planeH: number) {
  const { xT, yT } = progress(mult)
  const x = 10 + xT * Math.max(0, width - planeW - 20)
  const y = (height - planeH - 18) - yT * Math.max(0, height - planeH - 40)
  return { x, y, xT }
}

let raf = 0
let origin: number | null = null
let syncedM = -1
let crashAt = 0
let crashM = 1
let countdownUntil = 0
let skyW = 0
let skyH = 0
let planeW = 160
let planeH = 57
let lastPhase = ''
let reduce = false
let resizeObs: ResizeObserver | undefined

function measure() {
  const sky = skyEl.value
  const canvas = canvasEl.value
  const plane = planeEl.value
  if (!sky || !canvas) return
  const rect = sky.getBoundingClientRect()
  skyW = rect.width
  skyH = rect.height
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const pxW = Math.max(1, Math.round(rect.width * dpr))
  const pxH = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW
    canvas.height = pxH
  }
  if (plane) {
    planeW = plane.offsetWidth || planeW
    planeH = plane.offsetHeight || planeH
  }
}

function enter(phase: string, now: number) {
  if (phase === 'flying') {
    const m = Math.max(1, props.multiplier)
    origin = now - secondsFor(m) * 1000
    syncedM = m
  } else if (phase === 'crashed') {
    crashAt = now
    crashM = Math.max(1, props.multiplier)
    crashText.value = `${crashM.toFixed(2)}x`
    origin = null
  } else if (phase === 'betting') {
    countdownUntil = now + Math.max(0, props.countdownMs)
    origin = null
  }
}

function drawTrail(mult: number, alpha: number) {
  const canvas = canvasEl.value
  if (!canvas || skyW < 2 || skyH < 2) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = canvas.width / skyW
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, skyW, skyH)
  if (mult <= 1.001 || alpha <= 0) return
  const steps = 42
  const pts: { x: number, y: number }[] = []
  for (let i = 0; i <= steps; i += 1) {
    const m = Math.exp(Math.log(mult) * (i / steps))
    const p = place(m, skyW, skyH, planeW, planeH)
    pts.push({ x: p.x + planeW * 0.22, y: p.y + planeH * 0.55 })
  }
  const last = pts[pts.length - 1]
  ctx.beginPath()
  ctx.moveTo(pts[0].x, skyH)
  for (const p of pts) ctx.lineTo(p.x, p.y)
  ctx.lineTo(last.x, skyH)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, skyH, 0, last.y)
  grad.addColorStop(0, `rgba(120, 8, 16, ${0.02 * alpha})`)
  grad.addColorStop(0.45, `rgba(220, 24, 36, ${0.22 * alpha})`)
  grad.addColorStop(1, `rgba(255, 45, 55, ${0.5 * alpha})`)
  ctx.fillStyle = grad
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.strokeStyle = `rgba(255, 64, 72, ${0.95 * alpha})`
  ctx.lineWidth = Math.max(2, skyW / 280)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

function setLabel(text: string) {
  if (label.value !== text) label.value = text
}

function park(now: number) {
  const plane = planeEl.value
  if (!plane || skyW < 2) return
  const waiting = place(1, skyW, skyH, planeW, planeH)
  plane.style.transform = `translate3d(${waiting.x}px, ${waiting.y}px, 0) rotate(-8deg)`
  plane.style.opacity = '1'
  if (props.phase === 'betting') {
    const left = Math.max(0, countdownUntil - now)
    setLabel(String(Math.max(1, Math.ceil(left / 1000))))
  } else if (!props.enabled) {
    setLabel(t('aviator.disabled'))
  } else {
    setLabel(t('aviator.wait'))
  }
  drawTrail(1, 0)
}

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  const phase = props.phase
  if (phase !== lastPhase) {
    enter(phase, now)
    lastPhase = phase
  }
  if (skyW < 2) measure()
  const plane = planeEl.value
  if (!plane) return

  if (phase === 'betting') {
    const localLeft = countdownUntil - now
    if (Math.abs(localLeft - props.countdownMs) > 500) countdownUntil = now + props.countdownMs
    park(now)
    return
  }

  if (phase === 'flying') {
    const serverM = Math.max(1, props.multiplier)
    if (serverM !== syncedM) {
      const target = now - secondsFor(serverM) * 1000
      origin = origin == null ? target : origin + (target - origin) * 0.5
      syncedM = serverM
    }
    const elapsed = origin == null ? 0 : (now - origin) / 1000
    const m = multiplierAt(elapsed)
    const p = place(m, skyW, skyH, planeW, planeH)
    const bob = reduce ? 0 : Math.sin(now / 240) * Math.min(6, skyH * 0.02)
    const pitch = reduce ? 0 : Math.sin(now / 240 + 0.7) * 2.4
    const rot = -5 - (1 - p.xT) * 14 + pitch
    plane.style.transform = `translate3d(${p.x}px, ${p.y + bob}px, 0) rotate(${rot}deg)`
    plane.style.opacity = '1'
    const shown = m.toFixed(2)
    setLabel(`${shown}x`)
    emit('live', Number(shown))
    drawTrail(m, 1)
    return
  }

  if (phase === 'crashed') {
    const dur = reduce ? 0 : 500
    const u = dur === 0 ? 1 : Math.min(1, (now - crashAt) / dur)
    const ease = u * u
    const p = place(crashM, skyW, skyH, planeW, planeH)
    const x = p.x + ease * (skyW + planeW * 0.35)
    const y = p.y - ease * skyH * 0.28
    const rot = -6 - ease * 22
    plane.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rot}deg)`
    plane.style.opacity = String(1 - ease * 0.15)
    setLabel(t('aviator.flewAway'))
    const fade = 1 - Math.min(1, (now - crashAt) / 900) * 0.65
    drawTrail(crashM, fade)
    return
  }

  park(now)
}

watch(() => props.countdownMs, (ms) => {
  if (props.phase === 'betting') {
    const now = performance.now()
    if (Math.abs(countdownUntil - now - ms) > 500) countdownUntil = now + ms
  }
})

function onVisibility() {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  } else if (!raf) {
    raf = requestAnimationFrame(frame)
  }
}

onMounted(() => {
  reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  measure()
  if (skyEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => measure())
    resizeObs.observe(skyEl.value)
  }
  window.addEventListener('resize', measure)
  document.addEventListener('visibilitychange', onVisibility)
  raf = requestAnimationFrame(frame)
})

onUnmounted(() => {
  if (raf) cancelAnimationFrame(raf)
  resizeObs?.disconnect()
  window.removeEventListener('resize', measure)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div ref="skyEl" class="av-sky" :class="phase" data-testid="aviator-sky">
    <canvas ref="canvasEl" class="av-trail" data-testid="aviator-trail"></canvas>
    <div ref="planeEl" class="av-plane" data-testid="aviator-plane">
      <picture class="av-plane-body">
        <source :srcset="planeWebp" type="image/webp" />
        <img :src="planePng" alt="" @load="measure" />
      </picture>
      <picture class="av-prop" aria-hidden="true">
        <source :srcset="propWebp" type="image/webp" />
        <img :src="propPng" alt="" />
      </picture>
    </div>
    <div class="av-readout">
      <p class="av-phase">{{ phase === 'betting' ? $t('aviator.betting') : (phase === 'flying' ? $t('aviator.flying') : '') }}</p>
      <h1 data-testid="aviator-multiplier" :class="{ crash: phase === 'crashed' }">{{ label }}</h1>
      <p v-if="phase === 'crashed'" class="av-crash">{{ crashText }}</p>
      <p class="av-meta">{{ $t('aviator.viewers', { n: viewerCount }) }} · RTP {{ (rtpBps / 100).toFixed(2) }}%</p>
    </div>
  </div>
</template>
