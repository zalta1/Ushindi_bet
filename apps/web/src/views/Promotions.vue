<script setup lang="ts">
import {promos} from '../data/mock';
</script>
<template><h2>Promotions</h2><div class="card" v-for="p in promos">{{ $i18n.locale==='sw'?p.sw:p.en }}<br/><small>Wagering applies to bonus only.</small></div></template>
