<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = { diceEnabled: boolean; diceRtpBps: number; diceMinStake: number; diceMaxStake: number; diceMaxWin: number }
type Bet = { id: string; phone?: string; stakeTzs: number; target: number; side: string; roll: number; multiplier: number; payoutTzs: number; won: boolean }
type Pnl = { stakes: number; payouts: number; profit: number; bets: number }

const { t, locale } = useI18n()
const settings = ref<Settings | null>(null)
const bets = ref<Bet[]>([])
const pnl = ref<Pnl | null>(null)
const error = ref('')
const notice = ref('')
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

async function load() {
  const data = await api<{ settings: Settings; pnl: Pnl; bets: Bet[] }>('/api/admin/dice')
  settings.value = { ...data.settings }
  pnl.value = data.pnl
  bets.value = data.bets
}

async function save() {
  if (!settings.value) return
  error.value = ''
  notice.value = ''
  try {
    settings.value = await api<Settings>('/api/admin/dice/settings', { method: 'PATCH', json: settings.value })
    notice.value = t('dice.adminSaved')
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'error' }
})
</script>

<template>
  <div data-testid="admin-dice">
    <p v-if="error" class="form-error" data-testid="admin-dice-error">{{ error }}</p>
    <p v-if="notice" data-testid="admin-dice-notice">{{ notice }}</p>
    <p class="muted">{{ $t('dice.adminHelp') }}</p>
    <p v-if="pnl">{{ $t('dice.adminBets') }} {{ pnl.bets }} · {{ $t('dice.stake') }} {{ money(pnl.stakes) }} · {{ $t('dice.adminPayouts') }} {{ money(pnl.payouts) }} · {{ $t('dice.adminProfit') }} {{ money(pnl.profit) }}</p>
    <form v-if="settings" class="jackpot-form" @submit.prevent="save">
      <label>{{ $t('dice.adminEnabled') }}
        <input v-model="settings.diceEnabled" data-testid="admin-dice-enabled" type="checkbox" />
      </label>
      <label>RTP (bps)
        <input v-model.number="settings.diceRtpBps" data-testid="admin-dice-rtp" type="number" min="9000" max="9900" step="1" />
      </label>
      <label>{{ $t('dice.adminMin') }}
        <input v-model.number="settings.diceMinStake" data-testid="admin-dice-min" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('dice.adminMax') }}
        <input v-model.number="settings.diceMaxStake" data-testid="admin-dice-max" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('dice.adminMaxWin') }}
        <input v-model.number="settings.diceMaxWin" data-testid="admin-dice-max-win" type="number" min="1" step="1" />
      </label>
      <button type="submit" data-testid="admin-dice-save">{{ $t('adminSave') }}</button>
    </form>
    <h3>{{ $t('dice.history') }}</h3>
    <p v-if="!bets.length" class="muted">{{ $t('adminNoRows') }}</p>
    <p v-for="bet in bets" :key="bet.id" data-testid="admin-dice-bet">
      <b>{{ bet.phone }}</b> · {{ bet.roll }} {{ bet.side }} {{ bet.target }} · {{ bet.multiplier.toFixed(2) }}x · {{ money(bet.stakeTzs) }} → {{ money(bet.payoutTzs) }} · {{ bet.won ? $t('dice.win') : $t('dice.loss') }}
    </p>
  </div>
</template>
