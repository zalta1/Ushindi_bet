<script setup lang="ts">
import { onMounted } from 'vue'
import { useMatches, useSlip } from '../stores/store'

const ms = useMatches()
const slip = useSlip()
onMounted(() => { if (!ms.loaded) void ms.load() })
</script>
<template>
  <h2>{{ $t('live') }}</h2>
  <div class="match" v-for="m in ms.list.filter((item) => item.live)" :key="m.id">
    <RouterLink :to="`/match/${m.id}`"><b>{{ m.home }} vs {{ m.away }}</b> <span class="live">{{ m.minute }}' {{ m.hs }}-{{ m.as }}</span></RouterLink>
    <div class="odds">
      <button v-for="o in m.odds" :key="o.oddsId" type="button" @click="slip.toggle(m, o)">{{ o.sel }}<b>{{ o.price.toFixed(2) }}</b></button>
    </div>
  </div>
  <p v-if="ms.loaded && !ms.list.some((item) => item.live)">{{ $t('noMatches') }}</p>
</template>
