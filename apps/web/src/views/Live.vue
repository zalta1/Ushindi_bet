<script setup lang="ts">
import {useMatches,useSlip} from '../stores/store';const ms:any=useMatches(),slip=useSlip();
</script>
<template><h2>Live</h2><div class="match" v-for="m in ms.list.filter((x:any)=>x.live)" :key="m.id"><RouterLink :to="`/match/${m.id}`"><b>{{m.home}} vs {{m.away}}</b> <span class="live">{{m.minute}}' {{m.hs}}-{{m.as}}</span></RouterLink><div class="odds"><button v-for="o in m.odds" @click="slip.toggle(m,o)">{{o.sel}}<b>{{o.price.toFixed(2)}}</b></button></div></div></template>
