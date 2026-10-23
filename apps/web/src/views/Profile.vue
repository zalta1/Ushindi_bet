<script setup lang="ts">
import { ref } from 'vue'
import { ApiClientError } from '../api'
import { fmt } from '../data/mock'
import { useAuth } from '../stores/store'

const auth = useAuth()
const currentPassword = ref('')
const newPassword = ref('')
const message = ref('')
const error = ref('')
const busy = ref(false)

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
    error.value = err instanceof ApiClientError ? err.code : 'error'
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
    <input v-model="newPassword" type="password" autocomplete="new-password" data-testid="profile-next" />
    <button :disabled="busy" @click="save" data-testid="profile-save">{{ $t('changePassword') }}</button>
    <p v-if="message">{{ $t('passwordChanged') }}</p>
    <p v-if="error" class="form-error">{{ error }}</p>
  </div>
</template>
