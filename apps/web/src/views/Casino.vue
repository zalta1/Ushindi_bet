<script setup lang="ts">
import {casinoGames} from '../data/mock';
</script>
<template><h2>Casino</h2><div class="grid"><div class="tile" v-for="g in casinoGames">{{g}}<br/><button>Play (mock, demo balance)</button></div></div></template>
