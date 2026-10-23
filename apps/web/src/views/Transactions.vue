<script setup lang="ts">
import {useWallet} from '../stores/store';import {fmt} from '../data/mock';const w=useWallet();
</script>
<template><h2>Transactions</h2><div class="card" v-for="t in w.txns">{{t.type}} — {{fmt(t.amount)}} · {{t.provider}} · {{t.at}}</div></template>
