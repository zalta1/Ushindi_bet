<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ApiClientError } from '../api'
import { useAuth } from '../stores/store'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const { t } = useI18n()
const phone = ref('+255')
const fullName = ref('')
const dob = ref('')
const password = ref('')
const confirm = ref('')
const errorCode = ref('')
const busy = ref(false)

const mode = computed(() => route.path.includes('register') ? 'register' : route.path.includes('forgot') ? 'forgot' : 'login')
watch(mode, () => { errorCode.value = '' })

const errorKeys: Record<string, string> = {
  invalid_phone: 'errPhone',
  weak_password: 'errPassword',
  validation: 'errGeneric',
  underage: 'errAge',
  phone_taken: 'errPhoneTaken',
  invalid_credentials: 'errCredentials',
  locked: 'errLocked',
  rate_limited: 'errRate',
  invalid_name: 'errName',
  csrf_invalid: 'errGeneric',
  same_password: 'errPassword',
}
const error = computed(() => {
  if (!errorCode.value) return ''
  return t(errorKeys[errorCode.value] || errorCode.value)
})

function safeNext(value: unknown) {
  if (typeof value !== 'string') return ''
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return ''
  return value
}

async function submit() {
  errorCode.value = ''
  if (mode.value === 'register' && password.value !== confirm.value) {
    errorCode.value = 'errMismatch'
    return
  }
  busy.value = true
  try {
    if (mode.value === 'register') {
      await auth.register({ phone: phone.value, password: password.value, fullName: fullName.value, dob: dob.value })
      await router.push('/deposit')
    } else {
      await auth.login({ phone: phone.value, password: password.value })
      await router.push(safeNext(route.query.next) || '/')
    }
  } catch (err) {
    errorCode.value = err instanceof ApiClientError ? err.code : 'request_failed'
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
      <p v-if="error" class="form-error">{{ error }}</p>
      <label>{{ $t('phoneLabel') }}</label>
      <input v-model="phone" inputmode="tel" autocomplete="tel" data-testid="auth-phone" />
      <template v-if="mode === 'register'">
        <label>{{ $t('fullName') }}</label>
        <input v-model="fullName" autocomplete="name" data-testid="auth-name" />
        <label>{{ $t('dob') }}</label>
        <input v-model="dob" type="date" data-testid="auth-dob" />
      </template>
      <label>{{ $t('password') }}</label>
      <input v-model="password" type="password" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" data-testid="auth-password" />
      <template v-if="mode === 'register'">
        <label>{{ $t('confirmPassword') }}</label>
        <input v-model="confirm" type="password" autocomplete="new-password" data-testid="auth-confirm" />
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
