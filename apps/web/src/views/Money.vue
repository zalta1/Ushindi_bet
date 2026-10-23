<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ApiClientError, api } from '../api'
import { normalizeTzPhone } from '../auth-rules'
import { useAuth, useWallet } from '../stores/store'

const QUICK = [30_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const wallet = useWallet()
const { t } = useI18n()
const isDep = computed(() => route.path.includes('deposit'))

const minDeposit = ref(30_000)
const maxDeposit = ref(5_000_000)
const amountText = ref('')
const national = ref('')
const phoneTouched = ref(false)
const amountError = ref('')
const phoneError = ref('')
const pending = ref(false)
const busy = ref(false)

const withdrawAmount = ref(10000)
const provider = ref('M-Pesa')

const amount = computed(() => {
  const digits = amountText.value.replace(/[^\d]/g, '')
  if (!digits) return 0
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : 0
})
const quick = computed(() => QUICK.filter((value) => value >= minDeposit.value && value <= maxDeposit.value))
const phoneOk = computed(() => Boolean(normalizeTzPhone(national.value)))
const canSubmit = computed(() => !busy.value && amount.value >= minDeposit.value && amount.value <= maxDeposit.value && phoneOk.value)

function tsh(value: number) {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US')
}
function quickLabel(value: number) {
  return value % 1000 === 0 ? `${value / 1000}K` : tsh(value)
}
function nationalFrom(e164: string) {
  const phone = normalizeTzPhone(e164)
  return phone ? `0${phone.slice(4)}` : ''
}

watch(() => auth.user?.phone, (phone) => {
  if (phone && !phoneTouched.value) national.value = nationalFrom(phone)
}, { immediate: true })

onMounted(async () => {
  if (!auth.bootstrapped) await auth.bootstrap()
  try {
    const limits = await api<{ minDeposit: number; maxDeposit: number }>('/api/deposits/limits')
    if (Number.isInteger(limits.minDeposit) && limits.minDeposit > 0) minDeposit.value = limits.minDeposit
    if (Number.isInteger(limits.maxDeposit) && limits.maxDeposit > 0) maxDeposit.value = limits.maxDeposit
  } catch {
    // The server still enforces its own minimum if this read fails.
  }
})

function pick(value: number) {
  amountText.value = String(value)
  amountError.value = ''
}

function back() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

async function submitDeposit() {
  amountError.value = ''
  phoneError.value = ''
  pending.value = false
  if (!auth.user) {
    await router.push('/login?next=/deposit')
    return
  }
  if (!phoneOk.value) phoneError.value = t('errPhone')
  if (amount.value < minDeposit.value) amountError.value = t('depositBelowMin', { amount: tsh(minDeposit.value) })
  else if (amount.value > maxDeposit.value) amountError.value = t('depositAboveMax', { amount: tsh(maxDeposit.value) })
  if (amountError.value || phoneError.value) return
  busy.value = true
  try {
    await api('/api/deposits', { method: 'POST', json: { amount: amount.value, phone: national.value } })
    pending.value = true
  } catch (err) {
    if (err instanceof ApiClientError && err.code === 'unauthenticated') {
      await router.push('/login?next=/deposit')
      return
    }
    if (err instanceof ApiClientError && err.minDeposit) minDeposit.value = err.minDeposit
    if (err instanceof ApiClientError && err.maxDeposit) maxDeposit.value = err.maxDeposit
    if (err instanceof ApiClientError && (err.code === 'amount_below_minimum' || err.fields.amount === 'min_deposit')) {
      amountError.value = t('depositBelowMin', { amount: tsh(minDeposit.value) })
    } else if (err instanceof ApiClientError && (err.code === 'amount_above_maximum' || err.fields.amount === 'max_deposit')) {
      amountError.value = t('depositAboveMax', { amount: tsh(maxDeposit.value) })
    } else if (err instanceof ApiClientError && (err.code === 'invalid_phone' || err.fields.phone === 'invalid_phone')) {
      phoneError.value = t('errPhone')
    } else {
      amountError.value = t('errGeneric')
    }
  } finally {
    busy.value = false
  }
}

function withdraw() {
  if (withdrawAmount.value < 1000) return alert('Min TZS 1,000')
  if (withdrawAmount.value > wallet.balance) return alert('Balance')
  wallet.add(-withdrawAmount.value, 'withdraw', `${provider.value} (mock)`)
  alert('Sandbox completed')
}
</script>

<template>
  <section v-if="isDep" class="weka">
    <div class="weka-head">
      <button type="button" class="weka-back" @click="back" data-testid="deposit-back" aria-label="Back">←</button>
      <div>
        <h2 data-testid="deposit-title">{{ $t('deposit') }}</h2>
        <p class="weka-sub">{{ $t('depositSubtitle') }}</p>
      </div>
    </div>

    <div class="card weka-card">
      <div class="weka-card-head">
        <span>{{ $t('depositAmountLabel') }}</span>
        <span class="weka-min" data-testid="deposit-min">{{ $t('depositMin', { amount: tsh(minDeposit) }) }} <b class="tsh-badge">TSH</b></span>
      </div>
      <div class="quick-grid" data-testid="deposit-quick">
        <button
          v-for="value in quick"
          :key="value"
          type="button"
          class="quick"
          :class="{ active: amount === value }"
          @click="pick(value)"
        >{{ quickLabel(value) }}</button>
      </div>
      <label class="prefix-field">
        <span>TZS</span>
        <input
          v-model="amountText"
          type="number"
          min="0"
          step="1000"
          inputmode="numeric"
          :placeholder="$t('depositPlaceholder', { amount: tsh(minDeposit).replace(/,/g, '') })"
          data-testid="deposit-amount"
          @input="amountError = ''"
        />
      </label>
      <p v-if="amountError" class="form-error" data-testid="deposit-amount-error">{{ amountError }}</p>

      <p class="weka-label">{{ $t('depositPhone') }}</p>
      <label class="prefix-field">
        <span>+255</span>
        <input
          v-model="national"
          inputmode="tel"
          autocomplete="tel"
          placeholder="07XXXXXXXX"
          data-testid="deposit-phone"
          @input="phoneTouched = true; phoneError = ''"
        />
      </label>
      <p v-if="phoneError" class="form-error" data-testid="deposit-phone-error">{{ phoneError }}</p>
    </div>

    <div class="card weka-card">
      <h3>{{ $t('depositSteps') }}</h3>
      <ol class="weka-steps" data-testid="deposit-steps">
        <li>{{ $t('depositStep1') }}</li>
        <li>{{ $t('depositStep2') }}</li>
        <li>{{ $t('depositStep3', { amount: tsh(amount) }) }}</li>
      </ol>
    </div>

    <p v-if="pending" class="weka-note weka-pending" data-testid="deposit-pending">{{ $t('depositPending') }}</p>
    <button type="button" class="weka-submit" data-testid="deposit-submit" :disabled="!canSubmit" @click="submitDeposit">
      {{ $t('depositButton', { amount: tsh(amount) }) }}
    </button>
    <p class="weka-note" data-testid="deposit-note">{{ $t('depositNote') }}</p>
  </section>

  <section v-else>
    <h2>{{ $t('withdraw') }}</h2>
    <div class="card">
      <select v-model="provider">
        <option>M-Pesa</option>
        <option>Tigo Pesa</option>
        <option>Airtel Money</option>
        <option>HaloPesa</option>
      </select>
      <input type="number" v-model.number="withdrawAmount" />
      <button type="button" @click="withdraw">{{ $t('withdraw') }}</button>
    </div>
  </section>
</template>
