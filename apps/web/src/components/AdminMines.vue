<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = { minesEnabled: boolean; minesRtpBps: number; minesMinStake: number; minesMaxStake: number; minesMaxWin: number }
type Bet = { id: string; phone?: string; stakeTzs: number; mineCount: number; multiplier: number; payoutTzs: number; status: string; revealed: number[] }
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
const bets = ref<Bet[]>([])
const pnl = ref<Pnl | null>(null)
const error = ref('')
const notice = ref('')
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

async function load() {
  const data = await api<{ settings: Settings; budget: Budget; pnl: Pnl; bets: Bet[] }>('/api/admin/mines')
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
    settings.value = await api<Settings>('/api/admin/mines/settings', { method: 'PATCH', json: settings.value })
    notice.value = t('mines.adminSaved')
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
    budget.value = await api<Budget>('/api/admin/mines/budget', { method: 'PATCH', json: patch })
    budgetInput.value = budget.value.budgetTzs
    notice.value = t('mines.budgetSaved')
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
  <div data-testid="admin-mines">
    <p v-if="error" class="form-error" data-testid="admin-mines-error">{{ error }}</p>
    <p v-if="notice" data-testid="admin-mines-notice">{{ notice }}</p>
    <p class="muted">{{ $t('mines.adminHelp') }}</p>
    <p v-if="pnl">{{ $t('mines.adminBets') }} {{ pnl.bets }} · {{ $t('mines.stake') }} {{ money(pnl.stakes) }} · {{ $t('mines.adminPayouts') }} {{ money(pnl.payouts) }} · {{ $t('mines.adminProfit') }} {{ money(pnl.profit) }}</p>
    <form v-if="settings" class="jackpot-form" @submit.prevent="save">
      <label>{{ $t('mines.adminEnabled') }}
        <input v-model="settings.minesEnabled" data-testid="admin-mines-enabled" type="checkbox" />
      </label>
      <label>RTP (bps)
        <input v-model.number="settings.minesRtpBps" data-testid="admin-mines-rtp" type="number" min="9000" max="9900" step="1" />
      </label>
      <label>{{ $t('mines.adminMin') }}
        <input v-model.number="settings.minesMinStake" data-testid="admin-mines-min" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('mines.adminMax') }}
        <input v-model.number="settings.minesMaxStake" data-testid="admin-mines-max" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('mines.adminMaxWin') }}
        <input v-model.number="settings.minesMaxWin" data-testid="admin-mines-max-win" type="number" min="1" step="1" />
      </label>
      <button type="submit" data-testid="admin-mines-save">{{ $t('adminSave') }}</button>
    </form>

    <section v-if="budget" class="card dice-budget" data-testid="admin-mines-budget">
      <h3>{{ $t('mines.budgetTitle') }}</h3>
      <p class="muted">{{ budget.enabled ? $t('mines.budgetOn') : $t('mines.budgetOff') }}</p>
      <label>{{ $t('mines.budgetTitle') }}
        <input :checked="budget.enabled" data-testid="admin-mines-budget-enabled" type="checkbox" @change="onBudgetToggle" />
      </label>
      <p data-testid="admin-mines-remaining">{{ $t('mines.budgetRemaining') }} <b>{{ money(budget.budgetRemaining) }}</b> · {{ $t(`mines.health_${budget.healthLabel}`) }}</p>
      <p>{{ $t('mines.budgetAmount') }} {{ money(budget.budgetTzs) }} · {{ $t('mines.adminBets') }} {{ money(budget.totalBetsTzs) }} · {{ $t('mines.adminPayouts') }} {{ money(budget.totalPayoutsTzs) }}</p>
      <p data-testid="admin-mines-loss-rate">{{ $t('mines.budgetLoss') }} <b>{{ Math.round(budget.lossRate * 100) }}%</b></p>
      <p data-testid="admin-mines-cap">{{ $t('mines.budgetCap') }} {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
        <b v-if="budget.isPayoutCapReached">{{ $t('mines.budgetCapHit') }}</b>
      </p>
      <form class="jackpot-form" @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
        <label>{{ $t('mines.budgetSet') }}
          <input v-model.number="budgetInput" data-testid="admin-mines-budget-amount" type="number" min="0" step="1" />
        </label>
        <button type="submit" data-testid="admin-mines-budget-save">{{ $t('mines.budgetSave') }}</button>
        <button type="button" data-testid="admin-mines-budget-reset" @click="saveBudget({ resetCounters: true })">{{ $t('mines.budgetReset') }}</button>
      </form>
      <div class="chips">
        <button v-for="amt in [10000, 25000, 50000, 100000]" :key="amt" type="button" @click="budgetInput = amt">TSH {{ amt / 1000 }}K</button>
      </div>
    </section>

    <h3>{{ $t('mines.history') }}</h3>
    <p v-if="!bets.length" class="muted">{{ $t('adminNoRows') }}</p>
    <p v-for="bet in bets" :key="bet.id" data-testid="admin-mines-bet">
      <b>{{ bet.phone }}</b> · {{ bet.mineCount }} · {{ bet.revealed.length }} · {{ bet.multiplier.toFixed(2) }}x · {{ money(bet.stakeTzs) }} → {{ money(bet.payoutTzs) }} · {{ bet.status }}
    </p>
  </div>
</template>
