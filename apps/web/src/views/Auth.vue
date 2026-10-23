<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '../api'
import { normalizeTzPhone, passwordIssue, passwordIssueKey, type PasswordIssue } from '../auth-rules'
import { useAuth } from '../stores/store'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { t } = useI18n()
const phone = ref('')
const password = ref('')
const confirm = ref('')
const fieldErrors = reactive({ phone: '', password: '', confirm: '' })
const lockedMinutes = ref(15)
const busy = ref(false)

const mode = computed(() => route.path.includes('register') ? 'register' : route.path.includes('forgot') ? 'forgot' : 'login')
watch(mode, () => {
  fieldErrors.phone = ''
  fieldErrors.password = ''
  fieldErrors.confirm = ''
})

function clearErrors() {
  fieldErrors.phone = ''
  fieldErrors.password = ''
  fieldErrors.confirm = ''
}

function passwordKey(issue: string) {
  return passwordIssueKey[issue as PasswordIssue] || 'errPassword'
}

function message(key: string) {
  if (key === 'errLocked') return t('errLocked', { n: lockedMinutes.value })
  return t(key)
}

function clientErrors() {
  clearErrors()
  if (!normalizeTzPhone(phone.value)) fieldErrors.phone = 'errPhone'
  if (mode.value === 'register') {
    const issue = passwordIssue(password.value, phone.value)
    if (issue) fieldErrors.password = passwordKey(issue)
    if (!confirm.value) fieldErrors.confirm = 'errRequired'
    else if (password.value !== confirm.value) fieldErrors.confirm = 'errMismatch'
  } else if (!password.value) {
    fieldErrors.password = 'errCredentials'
  }
  return !fieldErrors.phone && !fieldErrors.password && !fieldErrors.confirm
}

function showApiError(err: ApiClientError) {
  clearErrors()
  if (err.fields.phone === 'invalid_phone') fieldErrors.phone = 'errPhone'
  if (err.fields.phone === 'required') fieldErrors.phone = 'errRequired'
  if (err.code === 'phone_taken' || err.fields.phone === 'phone_taken') fieldErrors.phone = 'errPhoneTaken'
  const passwordIssueCode = err.fields.password
  if (passwordIssueCode && passwordIssueCode in passwordIssueKey) fieldErrors.password = passwordKey(passwordIssueCode)
  if (err.code === 'invalid_credentials') fieldErrors.password = 'errCredentials'
  if (err.code === 'locked') {
    lockedMinutes.value = err.minutes ?? 15
    fieldErrors.password = 'errLocked'
  }
  if (err.code === 'rate_limited') fieldErrors.password = 'errRate'
  if (!fieldErrors.phone && !fieldErrors.password && !fieldErrors.confirm) fieldErrors.password = 'errGeneric'
}

function safeNext(value: unknown) {
  if (typeof value !== 'string') return ''
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return ''
  return value
}

async function submit() {
  if (!clientErrors()) return
  busy.value = true
  try {
    if (mode.value === 'register') {
      await auth.register({ phone: phone.value, password: password.value })
      await router.push('/deposit')
    } else {
      await auth.login({ phone: phone.value, password: password.value })
      await router.push(safeNext(route.query.next) || '/')
    }
  } catch (err) {
    showApiError(err instanceof ApiClientError ? err : new ApiClientError(0, 'request_failed'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h2>{{ mode === 'register' ? $t('register') : mode === 'forgot' ? $t('forgot') : $t('login') }}</h2>
  <div class="card">
    <p v-if="mode === 'forgot'">{{ $t('forgotHelp') }}</p>
    <form v-else @submit.prevent="submit">
      <label for="auth-phone">{{ $t('phoneLabel') }}</label>
      <input id="auth-phone" v-model="phone" inputmode="tel" autocomplete="tel" placeholder="0712345678" :aria-invalid="!!fieldErrors.phone" data-testid="auth-phone" />
      <p v-if="fieldErrors.phone" class="form-error" data-testid="auth-phone-error">{{ message(fieldErrors.phone) }}</p>

      <label for="auth-password">{{ $t('password') }}</label>
      <p v-if="mode === 'register'" class="field-hint" data-testid="auth-password-rules">{{ $t('passwordRules') }}</p>
      <input id="auth-password" v-model="password" type="password" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" :aria-invalid="!!fieldErrors.password" data-testid="auth-password" />
      <p v-if="fieldErrors.password" class="form-error" data-testid="auth-password-error">{{ message(fieldErrors.password) }}</p>

      <template v-if="mode === 'register'">
        <label for="auth-confirm">{{ $t('confirmPassword') }}</label>
        <input id="auth-confirm" v-model="confirm" type="password" autocomplete="new-password" :aria-invalid="!!fieldErrors.confirm" data-testid="auth-confirm" />
        <p v-if="fieldErrors.confirm" class="form-error" data-testid="auth-confirm-error">{{ message(fieldErrors.confirm) }}</p>
      </template>
      <button type="submit" :disabled="busy" data-testid="auth-submit">{{ mode === 'register' ? $t('register') : $t('login') }}</button>
    </form>
    <p>
      <RouterLink v-if="mode !== 'login'" to="/login">{{ $t('login') }}</RouterLink>
      <RouterLink v-if="mode !== 'register'" to="/register">{{ $t('register') }}</RouterLink>
      <RouterLink v-if="mode !== 'forgot'" to="/forgot">{{ $t('forgot') }}</RouterLink>
    </p>
  </div>
</template>
