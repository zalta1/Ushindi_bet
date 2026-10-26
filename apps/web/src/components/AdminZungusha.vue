<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'

type Settings = {
  zungushaEnabled: boolean
  zungushaSpinCost: number
  zungushaMinStake: number
  zungushaMaxStake: number
  zungushaMaxPayout: number
}
type Reward = {
  id: string
  rewardKey: string
  label: string
  amount: number
  segmentCount: number
  weight: number
  color: string
  isLost: boolean
  isActive: boolean
  displayOrder: number
}
type Spin = {
  id: string
  phone?: string
  userId?: string
  rewardLabel: string
  stakeTzs: number
  payoutTzs: number
  createdAt: string
  forced?: boolean
}
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
const rewards = ref<Reward[]>([])
const spins = ref<Spin[]>([])
const budget = ref<Budget | null>(null)
const budgetInput = ref(25000)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const money = (n: number) => Number(n || 0).toLocaleString(locale.value === 'sw' ? 'sw-TZ' : 'en-TZ')
const ve = (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const active = computed(() => rewards.value.filter((reward) => reward.isActive))
const segments = computed(() => active.value.reduce((sum, reward) => sum + Number(reward.segmentCount), 0))
const totalWeight = computed(() => active.value.reduce((sum, reward) => sum + Number(reward.weight), 0))
const totalSpins = computed(() => spins.value.length)
const totalRevenue = computed(() => spins.value.reduce((sum, row) => sum + row.stakeTzs, 0))
const totalPayouts = computed(() => spins.value.reduce((sum, row) => sum + row.payoutTzs, 0))
const uniquePlayers = computed(() => new Set(spins.value.map((row) => row.userId)).size)
const edge = computed(() => (totalRevenue.value > 0 ? ((totalRevenue.value - totalPayouts.value) / totalRevenue.value * 100).toFixed(1) : '0'))

function share(weight: number) {
  return totalWeight.value > 0 ? ((Number(weight) / totalWeight.value) * 100).toFixed(2) : '0'
}

async function load() {
  loading.value = true
  error.value = ''
  const data = await api<{ settings: Settings; budget: Budget; rewards: Reward[]; spins: Spin[] }>('/api/admin/zungusha')
  settings.value = { ...data.settings }
  budget.value = data.budget
  budgetInput.value = data.budget.budgetTzs
  rewards.value = data.rewards.map((reward) => ({ ...reward }))
  spins.value = data.spins
  loading.value = false
}

async function saveSettings() {
  if (!settings.value) return
  error.value = ''
  notice.value = ''
  try {
    settings.value = await api<Settings>('/api/admin/zungusha/settings', { method: 'PATCH', json: settings.value })
    notice.value = 'Mipangilio imehifadhiwa'
  } catch {
    error.value = 'Hitilafu kuhifadhi'
  }
}

async function saveReward(reward: Reward) {
  error.value = ''
  notice.value = ''
  try {
    const saved = await api<{ reward: Reward }>(`/api/admin/zungusha/rewards/${reward.id}`, {
      method: 'PATCH',
      json: {
        label: reward.label.trim(),
        amountTzs: Number(reward.amount),
        segmentCount: Number(reward.segmentCount),
        weight: Number(reward.weight),
        color: reward.color,
        isLost: reward.isLost,
        isActive: reward.isActive,
        displayOrder: Number(reward.displayOrder),
      },
    })
    const index = rewards.value.findIndex((row) => row.id === reward.id)
    if (index >= 0) rewards.value[index] = saved.reward
    notice.value = 'Imehifadhiwa'
  } catch (err) {
    error.value = err instanceof ApiClientError ? 'Hitilafu kuhifadhi' : 'Hitilafu kuhifadhi'
  }
}

async function addReward() {
  error.value = ''
  notice.value = ''
  try {
    await api('/api/admin/zungusha/rewards', { method: 'POST', json: {} })
    await load()
  } catch {
    error.value = 'Hitilafu kuhifadhi'
  }
}

async function removeReward(reward: Reward) {
  if (!window.confirm('Una uhakika unataka kufuta tuzo hii?')) return
  error.value = ''
  notice.value = ''
  try {
    await api(`/api/admin/zungusha/rewards/${reward.id}`, { method: 'DELETE' })
    notice.value = 'Imefutwa'
    await load()
  } catch {
    error.value = 'Hitilafu kuhifadhi'
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
    budget.value = await api<Budget>('/api/admin/zungusha/budget', { method: 'PATCH', json: patch })
    budgetInput.value = budget.value.budgetTzs
    notice.value = t('zungusha.budgetSaved')
    await load()
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.code : 'error'
  }
}

onMounted(() => { void load() })
</script>

<template>
  <div data-testid="admin-zungusha" class="zungusha-admin">
    <p v-if="loading">Inapakia...</p>
    <template v-else>
      <div class="zungusha-admin-head">
        <h2>🎡 Zungusha</h2>
        <button type="button" @click="load">Refresh</button>
      </div>
      <p v-if="error" class="form-error" data-testid="admin-zungusha-error">{{ error }}</p>
      <p v-if="notice" data-testid="admin-zungusha-notice">{{ notice }}</p>
      <div class="zungusha-stats">
        <div class="card"><small>Spins</small><b>{{ totalSpins }}</b></div>
        <div class="card"><small>Mapato</small><b>TSh {{ ve(totalRevenue) }}</b></div>
        <div class="card"><small>Tuzo</small><b>TSh {{ ve(totalPayouts) }}</b></div>
        <div class="card"><small>Wachezaji</small><b>{{ uniquePlayers }}</b></div>
      </div>
      <p class="card" data-testid="admin-zungusha-edge">
        House edge: <b class="up">{{ edge }}%</b>
        · Segments: <b>{{ segments }}</b>
        · Jumla ya uzito: <b>{{ totalWeight.toFixed(2) }}</b>
      </p>
      <form v-if="settings" class="card" @submit.prevent="saveSettings">
        <h3>Mipangilio</h3>
        <div class="zungusha-settings">
          <label>Gharama ya spin (TSh)
            <input v-model.number="settings.zungushaSpinCost" data-testid="admin-zungusha-cost" type="number" min="1" step="1" />
          </label>
          <label>Bet ya Chini
            <input v-model.number="settings.zungushaMinStake" data-testid="admin-zungusha-min" type="number" min="100" step="1" />
          </label>
          <label>Bet ya Juu
            <input v-model.number="settings.zungushaMaxStake" data-testid="admin-zungusha-max" type="number" min="100" step="1" />
          </label>
          <label>Kikomo cha Malipo
            <input v-model.number="settings.zungushaMaxPayout" data-testid="admin-zungusha-max-win" type="number" min="1" step="1" />
          </label>
          <label class="check">
            <input v-model="settings.zungushaEnabled" data-testid="admin-zungusha-enabled" type="checkbox" />
            Mchezo umewashwa
          </label>
        </div>
        <button type="submit" data-testid="admin-zungusha-save">Hifadhi</button>
      </form>

      <div class="card">
        <div class="zungusha-admin-head">
          <h3>Tuzo &amp; Uwezekano</h3>
          <button type="button" data-testid="admin-zungusha-add" @click="addReward">Ongeza</button>
        </div>
        <p class="muted">{{ $t('zungusha.adminHelp') }}</p>
        <div class="zungusha-table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Jina</th><th>Kiasi</th><th>Segments</th><th>Uzito (%)</th><th>Rangi</th><th>LOST</th><th>Hai</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="reward in rewards" :key="reward.id">
                <td><input v-model.number="reward.displayOrder" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-order`" type="number" /></td>
                <td><input v-model="reward.label" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-label`" maxlength="40" /></td>
                <td><input v-model.number="reward.amount" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-amount`" type="number" min="0" step="1" /></td>
                <td><input v-model.number="reward.segmentCount" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-segments`" type="number" min="1" step="1" /></td>
                <td>
                  <input v-model.number="reward.weight" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-weight`" type="number" min="0" step="0.001" />
                  <small>{{ share(reward.weight) }}%</small>
                </td>
                <td><input v-model="reward.color" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-color`" type="color" /></td>
                <td><input v-model="reward.isLost" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-lost`" type="checkbox" /></td>
                <td><input v-model="reward.isActive" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-active`" type="checkbox" /></td>
                <td class="row-actions">
                  <button type="button" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-save`" @click="saveReward(reward)">Hifadhi</button>
                  <button type="button" :data-testid="`admin-zungusha-reward-${reward.rewardKey}-delete`" @click="removeReward(reward)">Futa</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <section v-if="budget" class="card dice-budget" data-testid="admin-zungusha-budget">
        <h3>{{ $t('zungusha.budgetTitle') }}</h3>
        <p class="muted">{{ budget.enabled ? $t('zungusha.budgetOn') : $t('zungusha.budgetOff') }}</p>
        <label>{{ $t('zungusha.budgetTitle') }}
          <input :checked="budget.enabled" data-testid="admin-zungusha-budget-enabled" type="checkbox" @change="onBudgetToggle" />
        </label>
        <p data-testid="admin-zungusha-remaining">{{ $t('zungusha.budgetRemaining') }} <b>{{ money(budget.budgetRemaining) }}</b> · {{ $t(`zungusha.health_${budget.healthLabel}`) }}</p>
        <p>{{ $t('zungusha.budgetAmount') }} {{ money(budget.budgetTzs) }} · {{ $t('zungusha.adminBets') }} {{ money(budget.totalBetsTzs) }} · {{ $t('zungusha.adminPayouts') }} {{ money(budget.totalPayoutsTzs) }}</p>
        <p data-testid="admin-zungusha-loss-rate">{{ $t('zungusha.budgetLoss') }} <b>{{ Math.round(budget.lossRate * 100) }}%</b></p>
        <p data-testid="admin-zungusha-cap">{{ $t('zungusha.budgetCap') }} {{ money(budget.totalPayoutsTzs) }} / {{ money(budget.payoutCap) }} ({{ budget.payoutCapPercent.toFixed(0) }}%)
          <b v-if="budget.isPayoutCapReached">{{ $t('zungusha.budgetCapHit') }}</b>
        </p>
        <form class="jackpot-form" @submit.prevent="saveBudget({ budgetTzs: Number(budgetInput) })">
          <label>{{ $t('zungusha.budgetSet') }}
            <input v-model.number="budgetInput" data-testid="admin-zungusha-budget-amount" type="number" min="0" step="1" />
          </label>
          <button type="submit" data-testid="admin-zungusha-budget-save">{{ $t('zungusha.budgetSave') }}</button>
          <button type="button" data-testid="admin-zungusha-budget-reset" @click="saveBudget({ resetCounters: true })">{{ $t('zungusha.budgetReset') }}</button>
        </form>
      </section>

      <div class="card">
        <h3>Spins 100 za Mwisho</h3>
        <div class="zungusha-table-wrap">
          <table>
            <thead>
              <tr><th>Wakati</th><th>User ID</th><th>Tuzo</th><th>Gharama</th><th>Ushindi</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in spins" :key="row.id" data-testid="admin-zungusha-spin">
                <td>{{ new Date(row.createdAt).toLocaleString() }}</td>
                <td>{{ row.phone || row.userId }}</td>
                <td>{{ row.rewardLabel }}<span v-if="row.forced"> · forced</span></td>
                <td>{{ ve(row.stakeTzs) }}</td>
                <td :class="row.payoutTzs > 0 ? 'up' : ''">{{ row.payoutTzs > 0 ? `+${ve(row.payoutTzs)}` : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
