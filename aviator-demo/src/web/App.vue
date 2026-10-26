<script setup lang="ts">
import Admin from './Admin.vue'
import Player from './Player.vue'

const admin = window.location.pathname.startsWith('/admin')
</script>

<template>
  <div class="demo-app">
    <p class="demo-banner" data-testid="demo-banner">DEMO - no real money</p>
    <header class="demo-nav">
      <b class="logo">Aviator</b>
      <a href="/" data-testid="demo-nav-player">Player</a>
      <a href="/admin" data-testid="demo-nav-admin">Presenter</a>
      <span class="demo-nav-note">Presentation only. Fake credit. No wallets.</span>
    </header>
    <main>
      <Admin v-if="admin" />
      <Player v-else />
    </main>
  </div>
</template>
