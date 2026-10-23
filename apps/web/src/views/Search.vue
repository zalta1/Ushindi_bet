<script setup lang="ts">
import {ref,computed} from 'vue';import {useMatches} from '../stores/store';const q=ref('');const ms:any=useMatches();const list=computed(()=>ms.list.filter((m:any)=>(m.home+m.away+m.league).toLowerCase().includes(q.value.toLowerCase())));
</script>
<template><h2>Search</h2><input v-model="q" :placeholder="$t('search')"/><div class="match" v-for="m in list"><RouterLink :to="`/match/${m.id}`">{{m.home}} vs {{m.away}} — {{m.league}}</RouterLink></div></template>
