<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '../api'
import { passwordIssueKey, type PasswordIssue } from '../auth-rules'
import { fmt } from '../data/mock'
import { useAuth } from '../stores/store'

const auth = useAuth()
const { t } = useI18n()
const currentPassword = ref('')
const newPassword = ref('')
const message = ref('')
const error = ref('')
const busy = ref(false)

function explain(err: unknown) {
  if (!(err instanceof ApiClientError)) return t('errGeneric')
  if (err.code === 'invalid_credentials') return t('errCredentials')
  if (err.code === 'locked') return t('errLocked', { n: err.minutes ?? 15 })
  const issue = err.fields.newPassword || err.fields.password
  if (issue && issue in passwordIssueKey) return t(passwordIssueKey[issue as PasswordIssue])
  if (err.code === 'same_password') return t('errSame')
  return t('errGeneric')
}

async function save() {
  message.value = ''
  error.value = ''
  busy.value = true
  try {
    await auth.changePassword(currentPassword.value, newPassword.value)
    currentPassword.value = ''
    newPassword.value = ''
    message.value = 'ok'
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h2>{{ $t('profile') }}</h2>
  <div v-if="!auth.user" class="card">
    <RouterLink to="/login">{{ $t('login') }}</RouterLink>
  </div>
  <div v-else class="card">
    <p>Phone: {{ auth.user.phone }}</p>
    <p>{{ $t('balance') }}: {{ fmt(auth.user.balanceTzs) }} | Bonus: {{ fmt(auth.user.bonusBalanceTzs) }}</p>
    <p>KYC: {{ auth.user.kycStatus }}</p>
    <RouterLink to="/responsible-gambling">Responsible Gambling / Deposit Limits</RouterLink><br />
    <RouterLink to="/transactions">Transactions</RouterLink>
    <h3>{{ $t('changePassword') }}</h3>
    <label>{{ $t('currentPassword') }}</label>
    <input v-model="currentPassword" type="password" autocomplete="current-password" data-testid="profile-current" />
    <label>{{ $t('newPassword') }}</label>
    <p class="field-hint">{{ $t('passwordRules') }}</p>
    <input v-model="newPassword" type="password" autocomplete="new-password" data-testid="profile-next" />
    <button :disabled="busy" @click="save" data-testid="profile-save">{{ $t('changePassword') }}</button>
    <p v-if="message">{{ $t('passwordChanged') }}</p>
    <p v-if="error" class="form-error">{{ error }}</p>
  </div>
</template>
