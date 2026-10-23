<script setup lang="ts">
import {useWallet,useAuth} from '../stores/store';import {fmt} from '../data/mock';const w=useWallet(),a=useAuth();
</script>
<template><h2>Profile</h2><div class="card"><p>Phone: {{a.user?.phone||'+255 7xx xxx xxx (demo)'}}</p><p>Balance: {{fmt(w.balance)}} | Bonus: {{fmt(w.bonus)}}</p><p>KYC: Pending (mock) — upload ID in production</p><RouterLink to="/responsible-gambling">Responsible Gambling / Deposit Limits</RouterLink><br/><RouterLink to="/transactions">Transactions</RouterLink></div></template>
