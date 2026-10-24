<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = { diceEnabled: boolean; diceRtpBps: number; diceMinStake: number; diceMaxStake: number; diceMaxWin: number }
type Bet = { id: string; phone?: string; stakeTzs: number; target: number; side: string; roll: number; multiplier: number; payoutTzs: number; won: boolean; forced: boolean }
type Pnl = { stakes: number; payouts: number; profit: number; bets: number }
type Budget = {
  budgetTzs: number
  totalBetsTzs: number
  totalPayoutsTzs: number
  enabled: boolean
  netProfit: number
  budgetRemaining: number
  lossRate: number
  payoutCap: number
  payoutCapPercent: number
  isPayoutCapReached: boolean
  healthLabel: 'good' | 'normal' | 'caution' | 'recovery' | 'danger'
}

const { t, locale } = useI18n()
const settings = ref<Settings | null>(null)
const budget = ref<Budget | null>(null)
const budgetInput = ref(25000)
const bets = ref<Bet[]>([])
const pnl = ref<Pnl | null>(null)
const error = ref('')
const notice = ref('')
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

async function load() {
  const data = await api<{ settings: Settings; budget: Budget; pnl: Pnl; bets: Bet[] }>('/api/admin/dice')
  settings.value = { ...data.settings }
  budget.value = data.budget
  budgetInput.value = data.budget.budgetTzs
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

function onBudgetToggle(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  void saveBudget({ enabled: checked })
}

async function saveBudget(patch: { budgetTzs?: number; enabled?: boolean; resetCounters?: boolean }) {
  error.value = ''
  notice.value = ''
  try {
    budget.value = await api<Budget>('/api/admin/dice/budget', { method: 'PATCH', json: patch })
    budgetInput.value = budget.value.budgetTzs
    notice.value = t('dice.budgetSaved')
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

    <section v-if="budget" class="card dice-budget" data-testid="admin-dice-budget">
      <h3>{{ $t('dice.budgetTitle') }}</h3>
      <p class="muted">{{ budget.enabled ? $t('dice.budgetOn') : $t('dice.budgetOff') }}</p>
      <label>{{ $t('dice.budgetTitle') }}
        <input :checked="budget.enabled" data-testid="admin-dice-budget-enabled" type="checkbox" @change="onBudgetToggle" />
      </label>
      <p data-testid="admin-dice-remaining">{{ $t('dice.budgetRemaining') }} <b>{{ money(budget.budgetRemaining) }}</b> · {{ $t(`dice.health_${budget.healthLabel}`) }}</p>
      <p>{{ $t('dice.budgetAmount') }} {{ money(budget.budgetTzs) }} · {{ $t('dice.adminBets') }} {{ money(budget.totalBetsTzs) }} · {{ $t('dice.adminPayouts') }} {{ money(budget.totalPayoutsTzs) }}</p>
      <p data-testid="admin-dice-loss-rate">{{ $t('dice.budgetLoss') }} <b>{{ Math.round(budget.lossRate * 100) }}%</b></p>
      <p data-testid="admin-dice-cap">{{ $t('dice.budgetCap') }} {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
        <b v-if="budget.isPayoutCapReached">{{ $t('dice.budgetCapHit') }}</b>
      </p>
      <form class="jackpot-form" @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
        <label>{{ $t('dice.budgetSet') }}
          <input v-model.number="budgetInput" data-testid="admin-dice-budget-amount" type="number" min="0" step="1" />
        </label>
        <button type="submit" data-testid="admin-dice-budget-save">{{ $t('dice.budgetSave') }}</button>
        <button type="button" data-testid="admin-dice-budget-reset" @click="saveBudget({ resetCounters: true })">{{ $t('dice.budgetReset') }}</button>
      </form>
      <div class="chips">
        <button v-for="amt in [10000, 25000, 50000, 100000]" :key="amt" type="button" @click="budgetInput = amt">TSH {{ amt / 1000 }}K</button>
      </div>
    </section>

    <h3>{{ $t('dice.history') }}</h3>
    <p v-if="!bets.length" class="muted">{{ $t('adminNoRows') }}</p>
    <p v-for="bet in bets" :key="bet.id" data-testid="admin-dice-bet">
      <b>{{ bet.phone }}</b> · {{ bet.roll }} {{ bet.side }} {{ bet.target }} · {{ bet.multiplier.toFixed(2) }}x · {{ money(bet.stakeTzs) }} → {{ money(bet.payoutTzs) }} · {{ bet.won ? $t('dice.win') : $t('dice.loss') }}<template v-if="bet.forced"> · {{ $t('dice.houseTag') }}</template>
    </p>
  </div>
</template>
