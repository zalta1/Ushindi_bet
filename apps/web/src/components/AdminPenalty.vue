<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = { penaltyEnabled: boolean; penaltyMinStake: number; penaltyMaxStake: number; penaltyMaxPayout: number }
type Zone = { zoneKey: string; label: string; multiplier: number; winChance: number; displayOrder: number; isActive: boolean }
type Shot = { id: string; phone?: string; zoneKey: string; outcome: string; stakeTzs: number; payoutTzs: number; multiplier: number; winChance?: number }
type Pnl = { stakes: number; payouts: number; profit: number; shots: number; goals: number; rtp: number }
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
const zones = ref<Zone[]>([])
const shots = ref<Shot[]>([])
const pnl = ref<Pnl | null>(null)
const error = ref('')
const notice = ref('')
const money = (n: number) => `TSH ${Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')}`

async function load() {
  const data = await api<{ settings: Settings; budget: Budget; zones: Zone[]; pnl: Pnl; shots: Shot[] }>('/api/admin/penalty')
  settings.value = { ...data.settings }
  budget.value = data.budget
  budgetInput.value = data.budget.budgetTzs
  zones.value = data.zones.map((zone) => ({ ...zone }))
  pnl.value = data.pnl
  shots.value = data.shots
}

async function save() {
  if (!settings.value) return
  error.value = ''
  notice.value = ''
  try {
    settings.value = await api<Settings>('/api/admin/penalty/settings', { method: 'PATCH', json: settings.value })
    notice.value = t('penalty.adminSaved')
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

async function saveZones() {
  error.value = ''
  notice.value = ''
  try {
    const payload = zones.value.map((zone) => ({
      zoneKey: zone.zoneKey,
      label: zone.label.trim(),
      multiplier: Number(zone.multiplier),
      winChance: Number(zone.winChance),
      isActive: zone.isActive,
    }))
    const saved = await api<{ zones: Zone[] }>('/api/admin/penalty/zones', { method: 'PATCH', json: { zones: payload } })
    zones.value = saved.zones.map((zone) => ({ ...zone }))
    notice.value = t('penalty.zonesSaved')
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
    budget.value = await api<Budget>('/api/admin/penalty/budget', { method: 'PATCH', json: patch })
    budgetInput.value = budget.value.budgetTzs
    notice.value = t('penalty.budgetSaved')
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

function rtp(zone: Zone) {
  return (Number(zone.winChance) * Number(zone.multiplier) * 100).toFixed(1)
}

onMounted(async () => {
  try { await load() } catch (err) { error.value = err instanceof ApiClientError ? err.code : 'error' }
})
</script>

<template>
  <div data-testid="admin-penalty">
    <p v-if="error" class="form-error" data-testid="admin-penalty-error">{{ error }}</p>
    <p v-if="notice" data-testid="admin-penalty-notice">{{ notice }}</p>
    <p class="muted">{{ $t('penalty.adminHelp') }}</p>
    <p v-if="pnl">
      {{ $t('penalty.adminBets') }} {{ pnl.shots }} · {{ $t('penalty.adminGoals') }} {{ pnl.goals }} ·
      {{ $t('penalty.stake') }} {{ money(pnl.stakes) }} · {{ $t('penalty.adminPayouts') }} {{ money(pnl.payouts) }} ·
      {{ $t('penalty.adminProfit') }} {{ money(pnl.profit) }} · {{ $t('penalty.adminRtp') }} {{ (pnl.rtp * 100).toFixed(1) }}%
    </p>
    <form v-if="settings" class="jackpot-form" @submit.prevent="save">
      <label>{{ $t('penalty.adminEnabled') }}
        <input v-model="settings.penaltyEnabled" data-testid="admin-penalty-enabled" type="checkbox" />
      </label>
      <label>{{ $t('penalty.adminMin') }}
        <input v-model.number="settings.penaltyMinStake" data-testid="admin-penalty-min" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('penalty.adminMax') }}
        <input v-model.number="settings.penaltyMaxStake" data-testid="admin-penalty-max" type="number" min="100" step="1" />
      </label>
      <label>{{ $t('penalty.adminMaxWin') }}
        <input v-model.number="settings.penaltyMaxPayout" data-testid="admin-penalty-max-win" type="number" min="1" step="1" />
      </label>
      <button type="submit" data-testid="admin-penalty-save">{{ $t('adminSave') }}</button>
    </form>

    <form class="penalty-zones-form" @submit.prevent="saveZones">
      <div v-for="zone in zones" :key="zone.zoneKey" class="card">
        <b>{{ zone.zoneKey }}</b>
        <label>{{ $t('penalty.adminLabel') }}
          <input v-model="zone.label" :data-testid="`admin-penalty-zone-${zone.zoneKey}-label`" maxlength="40" />
        </label>
        <label>{{ $t('penalty.adminMult') }}
          <input v-model.number="zone.multiplier" :data-testid="`admin-penalty-zone-${zone.zoneKey}-mult`" type="number" min="1" max="1000" step="0.1" />
        </label>
        <label>{{ $t('penalty.adminChance') }}
          <input v-model.number="zone.winChance" :data-testid="`admin-penalty-zone-${zone.zoneKey}-chance`" type="number" min="0" max="0.95" step="0.001" />
        </label>
        <label>{{ $t('penalty.adminActive') }}
          <input v-model="zone.isActive" :data-testid="`admin-penalty-zone-${zone.zoneKey}-active`" type="checkbox" />
        </label>
        <span>{{ $t('penalty.adminRtp') }} {{ rtp(zone) }}%</span>
      </div>
      <button type="submit" data-testid="admin-penalty-zones-save">{{ $t('penalty.adminSaveZones') }}</button>
    </form>

    <section v-if="budget" class="card dice-budget" data-testid="admin-penalty-budget">
      <h3>{{ $t('penalty.budgetTitle') }}</h3>
      <p class="muted">{{ budget.enabled ? $t('penalty.budgetOn') : $t('penalty.budgetOff') }}</p>
      <label>{{ $t('penalty.budgetTitle') }}
        <input :checked="budget.enabled" data-testid="admin-penalty-budget-enabled" type="checkbox" @change="onBudgetToggle" />
      </label>
      <p data-testid="admin-penalty-remaining">{{ $t('penalty.budgetRemaining') }} <b>{{ money(budget.budgetRemaining) }}</b> · {{ $t(`penalty.health_${budget.healthLabel}`) }}</p>
      <p>{{ $t('penalty.budgetAmount') }} {{ money(budget.budgetTzs) }} · {{ $t('penalty.adminBets') }} {{ money(budget.totalBetsTzs) }} · {{ $t('penalty.adminPayouts') }} {{ money(budget.totalPayoutsTzs) }}</p>
      <p data-testid="admin-penalty-loss-rate">{{ $t('penalty.budgetLoss') }} <b>{{ Math.round(budget.lossRate * 100) }}%</b></p>
      <p data-testid="admin-penalty-cap">{{ $t('penalty.budgetCap') }} {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
        <b v-if="budget.isPayoutCapReached">{{ $t('penalty.budgetCapHit') }}</b>
      </p>
      <form class="jackpot-form" @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
        <label>{{ $t('penalty.budgetSet') }}
          <input v-model.number="budgetInput" data-testid="admin-penalty-budget-amount" type="number" min="0" step="1" />
        </label>
        <button type="submit" data-testid="admin-penalty-budget-save">{{ $t('penalty.budgetSave') }}</button>
        <button type="button" data-testid="admin-penalty-budget-reset" @click="saveBudget({ resetCounters: true })">{{ $t('penalty.budgetReset') }}</button>
      </form>
      <div class="chips">
        <button v-for="amt in [10000, 25000, 50000, 100000]" :key="amt" type="button" @click="budgetInput = amt">TSH {{ amt / 1000 }}K</button>
      </div>
    </section>

    <h3>{{ $t('penalty.history') }}</h3>
    <p v-if="!shots.length" class="muted">{{ $t('adminNoRows') }}</p>
    <p v-for="shot in shots" :key="shot.id" data-testid="admin-penalty-bet">
      <b>{{ shot.phone }}</b> · {{ shot.zoneKey }} · {{ shot.outcome }} · {{ money(shot.stakeTzs) }} → {{ money(shot.payoutTzs) }}
      <span v-if="shot.winChance !== undefined"> · {{ (shot.winChance * 100).toFixed(1) }}%</span>
    </p>
  </div>
</template>
