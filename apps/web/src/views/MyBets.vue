<script setup lang="ts">
const bets=JSON.parse(localStorage.getItem('mybets')||'[]');
</script>
<template><h2>My Bets</h2><div class="card" v-for="b in bets">#{{b.id}} Stake TZS {{b.stake}} @ {{b.odds.toFixed(2)}} → Payout TZS {{Math.round(b.payout)}} — {{b.status}}<div v-for="i in b.items">{{i.match}} {{i.sel}} @ {{i.price}}</div></div><p v-if="!bets.length">No bets yet</p></template>
