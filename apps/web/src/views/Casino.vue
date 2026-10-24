<script setup lang="ts">
import { casinoGames } from '../data/mock'
</script>
<template>
  <h2>Casino</h2>
  <div class="grid">
    <RouterLink to="/dice" class="tile" data-testid="casino-dice"><h3>Dice</h3><p>1–100</p></RouterLink>
    <div class="tile" v-for="g in casinoGames" :key="g">{{ g }}<br/><button type="button">Play (mock, demo balance)</button></div>
  </div>
</template>
