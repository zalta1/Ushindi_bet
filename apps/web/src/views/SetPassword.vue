<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '../api'
import { passwordIssue, passwordIssueKey, type PasswordIssue } from '../auth-rules'
import { useAuth } from '../stores/store'

const auth = useAuth()
const router = useRouter()
const { t } = useI18n()
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

function explain(err: unknown) {
  if (!(err instanceof ApiClientError)) return t('errGeneric')
  if (err.code === 'same_password' || err.fields.newPassword === 'same_password') return t('errSame')
  const issue = err.fields.newPassword || err.fields.password
  if (issue && issue in passwordIssueKey) return t(passwordIssueKey[issue as PasswordIssue])
  if (err.code === 'rate_limited') return t('errRate')
  return t('errGeneric')
}

async function submit() {
  error.value = ''
  const issue = passwordIssue(password.value, auth.user?.phone ?? '')
  if (issue) {
    error.value = t(passwordIssueKey[issue])
    return
  }
  if (password.value !== confirm.value) {
    error.value = t('errMismatch')
    return
  }
  busy.value = true
  try {
    await auth.setPassword(password.value)
    password.value = ''
    confirm.value = ''
    await router.push('/')
  } catch (err) {
    error.value = explain(err)
  } finally {
    busy.value = false
  }
}

async function logout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <h2>{{ $t('setPasswordTitle') }}</h2>
  <div class="card" data-testid="set-password">
    <p data-testid="set-password-help">{{ $t('setPasswordHelp') }}</p>
    <form @submit.prevent="submit">
      <label for="set-password-new">{{ $t('newPassword') }}</label>
      <p class="field-hint">{{ $t('passwordRules') }}</p>
      <input id="set-password-new" v-model="password" type="password" autocomplete="new-password" data-testid="set-password-new" />
      <label for="set-password-confirm">{{ $t('confirmPassword') }}</label>
      <input id="set-password-confirm" v-model="confirm" type="password" autocomplete="new-password" data-testid="set-password-confirm" />
      <p v-if="error" class="form-error" data-testid="set-password-error">{{ error }}</p>
      <button type="submit" :disabled="busy" data-testid="set-password-submit">{{ $t('setPasswordSubmit') }}</button>
    </form>
    <button type="button" @click="logout" data-testid="set-password-logout">{{ $t('logout') }}</button>
  </div>
</template>
