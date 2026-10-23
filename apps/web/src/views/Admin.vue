<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiClientError, api } from '../api'
import { useAuth } from '../stores/store'

const auth = useAuth()
const cfg = ref({ margin: 6, minStake: 500, maxStake: 500000, minDeposit: 30000 })
const status = ref('')
const audit = ref<{ id: string; actor: string; action: string; created_at: string }[]>([])
const kyc = [
  { phone: '+255711000111', doc: 'NIDA', status: 'Pending' },
  { phone: '+255755000222', doc: 'Passport', status: 'Pending' },
]
const allowed = computed(() => Boolean(auth.user?.admin))
const canReadConfig = computed(() => auth.user?.permissions.includes('config.read') || auth.user?.permissions.includes('config.write'))
const canWrite = computed(() => Boolean(auth.user?.permissions.includes('config.write')))
const canAudit = computed(() => Boolean(auth.user?.permissions.includes('audit.read')))

onMounted(async () => {
  if (!auth.bootstrapped) await auth.bootstrap()
  if (!canReadConfig.value) return
  const remote = await api<{ marginBps: number; minStake: number; maxStake: number; minDeposit: number }>('/api/admin/config')
  cfg.value = { margin: remote.marginBps / 100, minStake: remote.minStake, maxStake: remote.maxStake, minDeposit: remote.minDeposit }
  if (!canAudit.value) return
  const log = await api<{ data: { id: string; actor: string; action: string; created_at: string }[] }>('/api/admin/audit')
  audit.value = log.data
})

async function save() {
  status.value = ''
  try {
    await api('/api/admin/config', {
      method: 'PATCH',
      json: {
        marginBps: Math.round(cfg.value.margin * 100),
        minStake: cfg.value.minStake,
        maxStake: cfg.value.maxStake,
        minDeposit: cfg.value.minDeposit,
      },
    })
    status.value = 'saved'
    if (canAudit.value) {
      const log = await api<{ data: { id: string; actor: string; action: string; created_at: string }[] }>('/api/admin/audit')
      audit.value = log.data
    }
  } catch (err) {
    status.value = err instanceof ApiClientError ? err.code : 'error'
  }
}
</script>

<template>
  <h2>{{ $t('admin') }}</h2>
  <div v-if="!allowed" class="card" data-testid="admin-gate">
    <p>{{ $t('adminDenied') }}</p>
  </div>
  <template v-else>
    <div class="card" data-testid="admin-panel">
      <h3>Margins & Limits</h3>
      <p v-if="!canReadConfig">{{ $t('adminSection') }}</p>
      <template v-else>
        Margin %<input type="number" v-model.number="cfg.margin" :disabled="!canWrite" data-testid="admin-margin" />
        Min stake<input type="number" v-model.number="cfg.minStake" :disabled="!canWrite" />
        Max stake<input type="number" v-model.number="cfg.maxStake" :disabled="!canWrite" />
        Min deposit (TZS)<input type="number" v-model.number="cfg.minDeposit" :disabled="!canWrite" data-testid="admin-min-deposit" />
        <button v-if="canWrite" @click="save" data-testid="admin-save">Save</button>
        <p v-if="status === 'saved'">{{ $t('saved') }}</p>
        <p v-else-if="status" class="form-error">{{ status }}</p>
      </template>
    </div>
    <div class="card">
      <h3>KYC Review Queue</h3>
      <div v-for="k in kyc" :key="k.phone">{{ k.phone }} {{ k.doc }} — {{ k.status }} <button>Approve</button> <button>Reject</button></div>
    </div>
    <div class="card">
      <h3>Audit Log (append-only)</h3>
      <p v-if="!audit.length">system boot · admin actions are written to the append-only audit log</p>
      <p v-for="row in audit" :key="row.id">{{ row.created_at }} · {{ row.actor }} · {{ row.action }}</p>
      <h3>Reports</h3>
      <p>GGR, deposits, withdrawals — ledger tables are ready; reports are not summed in this step.</p>
    </div>
  </template>
</template>
