<script setup lang="ts">
import { casinoGames } from '../data/mock'
</script>
<template>
  <h2>Casino</h2>
  <div class="grid">
    <RouterLink to="/dice" class="tile" data-testid="casino-dice"><h3>Dice</h3><p>1–100</p></RouterLink>
    <RouterLink to="/mines" class="tile" data-testid="casino-mines"><h3>Mines</h3><p>5×5</p></RouterLink>
    <RouterLink to="/mayan" class="tile" data-testid="casino-mayan"><h3>Mayan Gold</h3><p>24</p></RouterLink>
    <RouterLink to="/penalty" class="tile" data-testid="casino-penalty"><h3>Penalty</h3><p>9</p></RouterLink>
    <RouterLink to="/zungusha" class="tile" data-testid="casino-zungusha"><h3>Zungusha</h3><p>Spin</p></RouterLink>
    <div class="tile" v-for="g in casinoGames.filter((name) => name !== 'Mines')" :key="g">{{ g }}<br/><button type="button">Play (mock, demo balance)</button></div>
  </div>
</template>
