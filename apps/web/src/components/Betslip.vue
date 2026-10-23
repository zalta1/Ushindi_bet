<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { fmt } from '../data/mock'
import { useAuth, useSlip } from '../stores/store'

const slip = useSlip()
const auth = useAuth()
const router = useRouter()
const { t } = useI18n()

onMounted(() => { void slip.loadLimits() })

function message() {
  if (slip.error === 'unauthenticated') return t('errLogin')
  if (slip.error === 'insufficient_funds') return t('errFunds')
  if (slip.error === 'odds_changed') return t('errOdds')
  if (slip.error === 'match_closed' || slip.error === 'odds_suspended') return t('errMatchClosed')
  if (slip.error === 'min') return t('stakeMin', { n: slip.minStake.toLocaleString('en-US') })
  if (slip.error === 'max') return t('stakeMax', { n: slip.maxStake.toLocaleString('en-US') })
  if (slip.error) return t('errGeneric')
  return ''
}

async function place() {
  const ok = await slip.place()
  if (ok) await router.push('/my-bets')
  else if (slip.error === 'unauthenticated') await router.push('/login')
}
</script>
<template>
  <div :class="['slip', { open: slip.open }]" data-testid="betslip">
    <h3>{{ $t('betslip') }} ({{ slip.items.length }})</h3>
    <button v-if="slip.open" type="button" @click="slip.open = false">✕</button>
    <p class="muted">{{ slip.items.length > 1 ? $t('multi') : $t('single') }}</p>
    <div v-for="item in slip.items" :key="item.key">
      {{ item.match }} — {{ item.market }} {{ item.sel }} @ {{ item.price.toFixed(2) }}
      <button type="button" @click="slip.toggle({ id: item.matchId, home: item.match, away: '' }, item)">x</button>
    </div>
    <p v-if="!slip.items.length" class="muted">{{ $t('slipEmpty') }}</p>
    <label>{{ $t('stake') }}</label>
    <input type="number" :value="slip.stake" min="1" step="1" data-testid="stake-input" @input="slip.setStake(Number(($event.target as HTMLInputElement).value))" />
    <p class="muted">{{ $t('stakeMin', { n: slip.minStake.toLocaleString('en-US') }) }} · {{ $t('stakeMax', { n: slip.maxStake.toLocaleString('en-US') }) }}</p>
    <p>{{ $t('potential') }}: <b class="gold">{{ fmt(slip.payout) }}</b> <span v-if="slip.combined">({{ slip.combined.toFixed(2) }})</span></p>
    <p v-if="auth.user" class="muted">{{ $t('balance') }}: {{ fmt(auth.user.balanceTzs) }}</p>
    <p v-if="message()" class="live" data-testid="slip-error">{{ message() }}</p>
    <button type="button" data-testid="place-bet" :disabled="slip.placing || !slip.items.length" @click="place">{{ $t('place') }}</button>
  </div>
</template>
