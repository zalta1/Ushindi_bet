<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import planesWebp from '../assets/hero-planes.webp'
import planesPng from '../assets/hero-planes.png'
import playersWebp from '../assets/hero-players.webp'
import playersPng from '../assets/hero-players.png'

const { t } = useI18n()
const index = ref(0)
const paused = ref(false)
const reduced = ref(false)
const root = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let startX = 0
let startY = 0
let tracking = false

const slides = [
  {
    id: 'aviator',
    to: '/crash',
    title: 'heroAviatorTitle',
    body: 'heroAviatorBody',
    cta: 'heroAviatorCta',
    webp: planesWebp,
    png: planesPng,
    art: 'landing-planes',
    w: 1280,
    h: 873,
  },
  {
    id: 'live',
    to: '/live',
    title: 'heroLiveTitle',
    body: 'heroLiveBody',
    cta: 'heroLiveCta',
    webp: playersWebp,
    png: playersPng,
    art: 'landing-players',
    w: 1100,
    h: 1054,
  },
]

function stop() {
  if (timer) clearInterval(timer)
  timer = undefined
}

function start() {
  stop()
  if (paused.value || reduced.value) return
  timer = setInterval(() => {
    index.value = (index.value + 1) % slides.length
  }, 6000)
}

function pause() {
  paused.value = true
  stop()
}

function resume() {
  paused.value = false
  start()
}

function go(i: number) {
  index.value = (i + slides.length) % slides.length
  if (!paused.value) start()
}

function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next && root.value?.contains(next)) return
  resume()
}

function onTouchStart(e: TouchEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('a, button')) return
  tracking = true
  startX = e.touches[0].clientX
  startY = e.touches[0].clientY
}

function onTouchEnd(e: TouchEvent) {
  if (!tracking) return
  tracking = false
  const dx = e.changedTouches[0].clientX - startX
  const dy = e.changedTouches[0].clientY - startY
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) return
  go(index.value + (dx < 0 ? 1 : -1))
}

function focusDot(i: number) {
  const n = (i + slides.length) % slides.length
  root.value?.querySelectorAll<HTMLButtonElement>('.landing-dots button')[n]?.focus()
}

function onDotKey(e: KeyboardEvent, i: number) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    go(i + 1)
    focusDot(i + 1)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    go(i - 1)
    focusDot(i - 1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    go(0)
    focusDot(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    go(slides.length - 1)
    focusDot(slides.length - 1)
  }
}

function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('.landing-dots')) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    go(index.value + 1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    go(index.value - 1)
  }
}

onMounted(() => {
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  start()
})

onUnmounted(stop)
</script>

<template>
  <section
    ref="root"
    class="landing-hero"
    aria-roledescription="carousel"
    :aria-label="t('heroCarousel')"
    @mouseenter="pause"
    @mouseleave="resume"
    @focusin="pause"
    @focusout="onFocusOut"
    @keydown="onKey"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <div class="landing-viewport">
      <div class="landing-track" :style="{ transform: `translate3d(${-index * 100}%, 0, 0)` }">
        <article
          v-for="(slide, i) in slides"
          :id="`hero-slide-${slide.id}`"
          :key="slide.id"
          class="landing-slide"
          :class="{ 'is-active': i === index }"
          role="group"
          aria-roledescription="slide"
          :aria-label="t('heroSlide', { n: i + 1, total: slides.length })"
          :aria-hidden="i !== index ? 'true' : undefined"
          :inert="i !== index ? true : undefined"
        >
          <div class="landing-text">
            <h2>{{ t(slide.title) }}</h2>
            <p>{{ t(slide.body) }}</p>
            <router-link class="landing-cta" :to="slide.to">{{ t(slide.cta) }}</router-link>
          </div>
          <picture :class="['landing-art', slide.art]">
            <source type="image/webp" :srcset="slide.webp" />
            <img :src="slide.png" alt="" :width="slide.w" :height="slide.h" />
          </picture>
        </article>
      </div>
    </div>
    <div class="landing-dots" role="tablist" :aria-label="t('heroCarousel')">
      <button
        v-for="(slide, i) in slides"
        :key="slide.id"
        type="button"
        role="tab"
        :aria-selected="i === index"
        :aria-controls="`hero-slide-${slide.id}`"
        :tabindex="i === index ? 0 : -1"
        :aria-label="t('heroDot', { n: i + 1 })"
        @click="go(i)"
        @keydown="onDotKey($event, i)"
      />
    </div>
  </section>
</template>
