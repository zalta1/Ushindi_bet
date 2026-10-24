<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api'

type FairRound = {
  id: string
  roundNo: number
  status: string
  serverSeedHash: string
  serverSeed: string | null
  clientSeed: string
  nonce: number
  crashPoint: number | null
  rtpBps: number
  maxMultiplier: number
  verified: boolean | null
  computedCrashPoint: number | null
}

const route = useRoute()
const { t } = useI18n()
const round = ref<FairRound | null>(null)
const error = ref('')
const form = ref({ serverSeed: '', clientSeed: 'ushindi', nonce: 1, rtpBps: 9600, maxMultiplier: 1000 })
const checked = ref<{ serverSeedHash: string, crashHash: string, crashPoint: number } | null>(null)

async function load(id: string) {
  error.value = ''
  try {
    round.value = await api<FairRound>(`/api/aviator/rounds/${id}`)
    if (round.value.serverSeed) {
      form.value.serverSeed = round.value.serverSeed
      form.value.clientSeed = round.value.clientSeed
      form.value.nonce = round.value.nonce
      form.value.rtpBps = round.value.rtpBps
      form.value.maxMultiplier = round.value.maxMultiplier
    }
  } catch {
    error.value = t('aviator.errGeneric')
    round.value = null
  }
}

async function loadLatest() {
  const state = await api<{ history: { id: string }[] }>('/api/aviator/state')
  const id = typeof route.query.round === 'string' ? route.query.round : state.history[0]?.id
  if (id) await load(id)
}

async function verify() {
  error.value = ''
  checked.value = await api('/api/aviator/verify', { method: 'POST', json: { ...form.value } })
}

onMounted(() => { void loadLatest() })
watch(() => route.query.round, (id) => {
  if (typeof id === 'string') void load(id)
})
</script>

<template>
  <div class="aviator-fair" data-testid="aviator-fair">
    <p><RouterLink to="/aviator">← {{ $t('aviator.title') }}</RouterLink></p>
    <h2>{{ $t('aviator.fairTitle') }}</h2>
    <p>{{ $t('aviator.algorithm') }}</p>
    <p class="muted">{{ $t('aviator.noManipulation') }}</p>

    <div v-if="round" class="card" data-testid="aviator-fair-round">
      <h3>{{ $t('aviator.round') }} {{ round.roundNo }}</h3>
      <p>{{ $t('aviator.serverSeedHash') }}</p>
      <code>{{ round.serverSeedHash }}</code>
      <p>{{ $t('aviator.clientSeed') }}: {{ round.clientSeed }} · {{ $t('aviator.nonce') }}: {{ round.nonce }}</p>
      <p>RTP {{ (round.rtpBps / 100).toFixed(2) }}% · max {{ round.maxMultiplier }}x</p>
      <template v-if="round.serverSeed">
        <p>{{ $t('aviator.serverSeed') }}</p>
        <code>{{ round.serverSeed }}</code>
        <p data-testid="aviator-fair-result">
          {{ $t('aviator.crashPoint') }} {{ round.crashPoint?.toFixed(2) }}x
          · {{ round.verified ? $t('aviator.match') : $t('aviator.mismatch') }}
          ({{ round.computedCrashPoint?.toFixed(2) }}x)
        </p>
      </template>
      <p v-else class="muted">{{ $t('aviator.seedHidden') }}</p>
    </div>
    <p v-else class="muted">{{ $t('aviator.noHistory') }}</p>
    <p v-if="error" class="form-error">{{ error }}</p>

    <form class="card" @submit.prevent="verify">
      <h3>{{ $t('aviator.verify') }}</h3>
      <label>{{ $t('aviator.serverSeed') }}<input v-model="form.serverSeed" data-testid="aviator-fair-seed" /></label>
      <label>{{ $t('aviator.clientSeed') }}<input v-model="form.clientSeed" /></label>
      <label>{{ $t('aviator.nonce') }}<input type="number" v-model.number="form.nonce" /></label>
      <label>RTP bps<input type="number" v-model.number="form.rtpBps" /></label>
      <label>Max<input type="number" v-model.number="form.maxMultiplier" /></label>
      <button type="submit" data-testid="aviator-fair-check">{{ $t('aviator.verify') }}</button>
      <p v-if="checked" data-testid="aviator-fair-checked">{{ checked.crashPoint.toFixed(2) }}x · {{ checked.serverSeedHash.slice(0, 16) }}…</p>
    </form>
  </div>
</template>
