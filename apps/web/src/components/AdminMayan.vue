<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = { mayanEnabled: boolean; mayanMinStake: number; mayanMaxStake: number; mayanMaxWin: number }
type Spin = { id: string; phone?: string; stakeTzs: number; multiplier: number; label: string; payoutTzs: number; won: boolean; lossRate?: number }
type Pnl = { stakes: number; payouts: number; profit: number; bets: number }
type Budget = {
  budgetTzs: number
  totalBetsTzs: number
  totalPayoutsTzs: number
  enabled: boolean
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
const spins = ref<Spin[]>([])
const pnl = ref<Pnl | null>(null)
const error = ref('')
const notice = ref('')
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

async function load() {
  const data = await api<{ settings: Settings; budget: Budget; pnl: Pnl; spins: Spin[] }>('/api/admin/mayan')
  settings.value = { ...data.settings }
  budget.value = data.budget
  budgetInput.value = data.budget.budgetTzs
  pnl.value = data.pnl
  spins.value = data.spins
}

async function save() {
  if (!settings.value) return
  error.value = ''
  notice.value = ''
  try {
    settings.value = await api<Settings>('/api/admin/mayan/settings', { method: 'PATCH', json: settings.value })
    notice.value = t('mayan.adminSaved')
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
    budget.value = await api<Budget>('/api/admin/mayan/budget', { method: 'PATCH', json: patch })
    budgetInput.value = budget.value.budgetTzs
    notice.value = t('mayan.budgetSaved')
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
  <div data-testid="admin-mayan">
    <p v-if="error" class="form-error" data-testid="admin-mayan-error">{{ error }}</p>
    <p v-if="notice" data-testid="admin-mayan-notice">{{ notice }}</p>
    <p class="muted">{{ $t('mayan.adminHelp') }}</p>
    <p v-if="pnl">{{ $t('mayan.adminBets') }} {{ pnl.bets }} · {{ $t('mayan.stake') }} {{ money(pnl.stakes) }} · {{ $t('mayan.adminPayouts') }} {{ money(pnl.payouts) }} · {{ $t('mayan.adminProfit') }} {{ money(pnl.profit) }}</p>
    <form v-if="settings" class="jackpot-form" @submit.prevent="save">
      <label>{{ $t('mayan.adminEnabled') }}
        <input v-model="settings.mayanEnabled" data-testid="admin-mayan-enabled" type="checkbox" />
      </label>
      <label>{{ $t('mayan.adminMin') }}
        <input v-model.number="settings.mayanMinStake" data-testid="admin-mayan-min" type="number" min="50" step="1" />
      </label>
      <label>{{ $t('mayan.adminMax') }}
        <input v-model.number="settings.mayanMaxStake" data-testid="admin-mayan-max" type="number" min="50" step="1" />
      </label>
      <label>{{ $t('mayan.adminMaxWin') }}
        <input v-model.number="settings.mayanMaxWin" data-testid="admin-mayan-max-win" type="number" min="1" step="1" />
      </label>
      <button type="submit" data-testid="admin-mayan-save">{{ $t('adminSave') }}</button>
    </form>

    <section v-if="budget" class="card dice-budget" data-testid="admin-mayan-budget">
      <h3>{{ $t('mayan.budgetTitle') }}</h3>
      <p class="muted">{{ budget.enabled ? $t('mayan.budgetOn') : $t('mayan.budgetOff') }}</p>
      <label>{{ $t('mayan.budgetTitle') }}
        <input :checked="budget.enabled" data-testid="admin-mayan-budget-enabled" type="checkbox" @change="onBudgetToggle" />
      </label>
      <p data-testid="admin-mayan-remaining">{{ $t('mayan.budgetRemaining') }} <b>{{ money(budget.budgetRemaining) }}</b> · {{ $t(`mayan.health_${budget.healthLabel}`) }}</p>
      <p>{{ $t('mayan.budgetAmount') }} {{ money(budget.budgetTzs) }} · {{ $t('mayan.adminBets') }} {{ money(budget.totalBetsTzs) }} · {{ $t('mayan.adminPayouts') }} {{ money(budget.totalPayoutsTzs) }}</p>
      <p data-testid="admin-mayan-loss-rate">{{ $t('mayan.budgetLoss') }} <b>{{ Math.round(budget.lossRate * 100) }}%</b></p>
      <p data-testid="admin-mayan-cap">{{ $t('mayan.budgetCap') }} {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
        <b v-if="budget.isPayoutCapReached">{{ $t('mayan.budgetCapHit') }}</b>
      </p>
      <form class="jackpot-form" @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
        <label>{{ $t('mayan.budgetSet') }}
          <input v-model.number="budgetInput" data-testid="admin-mayan-budget-amount" type="number" min="0" step="1" />
        </label>
        <button type="submit" data-testid="admin-mayan-budget-save">{{ $t('mayan.budgetSave') }}</button>
        <button type="button" data-testid="admin-mayan-budget-reset" @click="saveBudget({ resetCounters: true })">{{ $t('mayan.budgetReset') }}</button>
      </form>
      <div class="chips">
        <button v-for="amt in [10000, 25000, 50000, 100000]" :key="amt" type="button" @click="budgetInput = amt">TSH {{ amt / 1000 }}K</button>
      </div>
    </section>

    <h3>{{ $t('mayan.history') }}</h3>
    <p v-if="!spins.length" class="muted">{{ $t('adminNoRows') }}</p>
    <p v-for="spin in spins" :key="spin.id" data-testid="admin-mayan-bet">
      <b>{{ spin.phone }}</b> · {{ spin.label }} · {{ money(spin.stakeTzs) }} → {{ money(spin.payoutTzs) }} · {{ spin.won ? $t('mayan.winTitle') : $t('mayan.lossShort') }}
      <span v-if="spin.lossRate !== undefined"> · {{ Math.round(spin.lossRate * 100) }}%</span>
    </p>
  </div>
</template>
