<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Betslip from './components/Betslip.vue'
import { useWallet, useSlip, useMatches, useAuth } from './stores/store'
import { fmt, sportsDetailed, promos } from './data/mock'
import { useI18n } from 'vue-i18n'
import { api } from './api'

const w = useWallet(), slip = useSlip(), ms: any = useMatches(), auth = useAuth(), router = useRouter(), route = useRoute(), { locale, t } = useI18n()
const age = ref(!localStorage.getItem('age18'))
const liveCount = computed(() => ms.list.filter((m: any) => m.live).length)

// Retractable left panel: desktop collapse persisted; mobile is an overlay drawer (hidden by default).
const collapsed = ref(localStorage.getItem('ushindi-sidebar') === 'collapsed')
const mobileOpen = ref(false)
function togglePanel() {
  if (window.innerWidth <= 900) {
    mobileOpen.value = !mobileOpen.value
  } else {
    collapsed.value = !collapsed.value
    localStorage.setItem('ushindi-sidebar', collapsed.value ? 'collapsed' : 'expanded')
  }
}
function closeMobile() { mobileOpen.value = false }
watch(() => route.path, closeMobile)

const isAdminRoute = computed(() => route.path.startsWith('/admin'))
function confirmAge() { localStorage.setItem('age18', '1'); age.value = false }
async function onLogout() { await auth.logout(); router.push('/') }
async function stopImpersonation() {
  await api('/api/auth/impersonation/stop', { method: 'POST', json: {} })
  await auth.loadMe()
}
function setLang(l: string) { locale.value = l; localStorage.setItem('lang', l) }
function toggleTheme() { document.documentElement.classList.toggle('light') }
function pick(s: string) { ms.setSport(s); closeMobile(); router.push('/') }

const menu = computed(() => [
  { to: '/', icon: '🏠', label: t('home') },
  { to: '/live', icon: '🔴', label: t('live'), badge: liveCount.value },
  { to: '/jackpots', icon: '🏆', label: t('jackpots') },
  { to: '/crash', icon: '🚀', label: t('crash') },
  { to: '/casino', icon: '🎰', label: t('casino') },
  { to: '/promotions', icon: '🎁', label: t('promos'), badge: promos.length },
  { to: '/virtuals', icon: '🎮', label: t('virtuals') },
  { to: '/livescore', icon: '📊', label: t('livescore') },
  { to: '/fixtures/print', icon: '🖨️', label: t('printFixtures') },
  { to: '/search', icon: '🔍', label: t('navSearch') },
])
const sportIcon = (name: string) => ({ Football: '⚽', Basketball: '🏀', Tennis: '🎾', Cricket: '🏏', Rugby: '🏉', Volleyball: '🏐', 'Ice Hockey': '🏒', 'Table Tennis': '🏓', Boxing: '🥊', 'American Football': '🏈', Baseball: '⚾', Handball: '🤾', eSoccer: '🎮', 'Counter-Strike': '🎯', Darts: '🎯', MMA: '🥋', Badminton: '🏸', Futsal: '⚽' } as Record<string, string>)[name] || name.slice(0, 2).toUpperCase()
</script>

<template>
  <div v-if="age" class="age"><div><h2>Ushindi Bet — 18+ Only</h2><p>Ni lazima uwe na miaka 18+. Kubeti kunahusisha hatari. / You must be 18+. Gambling involves risk.</p><button @click="confirmAge">Nina miaka 18+ / I am 18+</button> <RouterLink to="/responsible-gambling">Responsible Gambling</RouterLink></div></div>
  <div v-if="auth.user?.readOnly" class="impersonation-banner" data-testid="impersonation-banner">
    <span>{{ $t('impersonating', { phone: auth.user.phone }) }}</span>
    <button type="button" @click="stopImpersonation" data-testid="impersonation-stop">{{ $t('stopImpersonation') }}</button>
  </div>

  <!-- Header: logo, panel toggle, balance, language, theme, login, deposit ONLY (menu moved to left panel). No duplicated text nav. -->
  <header>
    <button class="panel-toggle" @click="togglePanel" :aria-label="collapsed ? $t('expand') : $t('collapse')" :title="collapsed ? $t('expand') : $t('collapse')">☰</button>
    <RouterLink class="logo" to="/">USHINDI BET</RouterLink>
    <span class="header-spacer"></span>
    <span class="header-balance">{{$t('balance')}}: {{fmt(auth.user ? auth.user.balanceTzs : w.balance)}}</span>
    <button @click="setLang(locale==='sw'?'en':'sw')" :title="locale==='sw' ? 'Switch to English' : 'Badili kwenda Kiswahili'">{{locale.toUpperCase()}}</button>
    <button @click="toggleTheme">Theme</button>
    <template v-if="auth.user">
      <span class="header-balance">{{ auth.user.phone }}</span>
      <button @click="onLogout" data-testid="logout">{{$t('logout')}}</button>
    </template>
    <RouterLink v-else to="/login">{{$t('login')}}/{{$t('register')}}</RouterLink>
    <RouterLink class="deposit-btn" to="/deposit">{{$t('deposit')}}</RouterLink>
  </header>

  <div class="layout" :class="{ collapsed, 'drawer-open': mobileOpen, 'admin-route': isAdminRoute }">
    <div v-if="mobileOpen" class="panel-backdrop" @click="closeMobile"></div>

    <!-- Retractable left panel: flush at left:0, retracts fully off-edge when collapsed (header ☰ reopens it). Main menu (no Login/Deposit/Balance) + sports list below -->
    <aside class="leftpanel" :class="{ collapsed, open: mobileOpen }" aria-label="Main navigation">
      <div class="panel-head">
        <span class="lp-label panel-title">{{$t('menu')}}</span>
        <button class="panel-chevron" @click="togglePanel" :aria-label="collapsed ? $t('expand') : $t('collapse')" :title="collapsed ? $t('expand') : $t('collapse')">{{ mobileOpen ? '✕' : '«' }}</button>
      </div>

      <nav class="mainmenu">
        <RouterLink v-for="item in menu" :key="item.to" :to="item.to" class="menuitem" :title="item.label" :aria-label="item.label">
          <span class="lp-icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="lp-label">{{ item.label }}</span>
          <span v-if="item.badge" class="badge lp-badge">{{ item.badge }}</span>
        </RouterLink>
      </nav>

      <hr class="lp-divider" />
      <h3 class="lp-section"><span class="lp-icon" aria-hidden="true">🏅</span><span class="lp-label">{{$t('sports')}}</span></h3>

      <button class="sportbtn menuitem" :class="{active: ms.selectedSport==='All'}" @click="pick('All')" :title="$t('allSports')" :aria-label="$t('allSports')"><span class="lp-icon" aria-hidden="true">🌍</span><span class="lp-label">{{$t('allSports')}}</span></button>
      <button v-for="s in sportsDetailed" :key="s.id" class="sportbtn menuitem" :class="{active: ms.selectedSport===s.name}" @click="pick(s.name)" :title="locale==='sw' ? s.sw : s.name" :aria-label="locale==='sw' ? s.sw : s.name"><span class="lp-icon" aria-hidden="true">{{ sportIcon(s.name) }}</span><span class="lp-label">{{locale==='sw' ? s.sw : s.name}}</span> <span class="count lp-count">{{s.count}}</span></button>

      <hr class="lp-divider" />
      <RouterLink to="/admin" class="menuitem admin-link" :title="$t('admin')" :aria-label="$t('admin')"><span class="lp-icon" aria-hidden="true">⚙️</span><span class="lp-label">{{$t('admin')}}</span></RouterLink>
    </aside>

    <main><RouterView /></main>
    <aside v-if="!isAdminRoute" class="slip-d"><Betslip /></aside>
  </div>

  <nav v-if="!isAdminRoute" class="bottombar"><RouterLink to="/">Home</RouterLink><RouterLink to="/live">Live</RouterLink><button @click="slip.open=true">Slip ({{slip.items.length}})</button><RouterLink to="/casino">Casino</RouterLink><RouterLink to="/profile">Profile</RouterLink></nav>
  <div v-if="slip.open"><Betslip /></div>
  <footer v-if="!isAdminRoute" style="padding:20px;text-align:center"><p class="seo">Ushindi Bet ni jukwaa la kubeti michezo na kasino lililotengenezwa kwa soko la Tanzania — kwa Kiswahili na Kiingereza, malipo kwa shilingi (TZS) kupitia njia za simu, na mechi za ndani na za kimataifa. Tunasisitiza uwazi: masharti ya uondoaji pesa yanaonyeshwa kabla ya kuweka amana, bonasi pekee ndiyo yenye masharti ya wagering, na zana za kudhibiti matumizi kama viwango vya amana, kupumzika na kujiondoa zinapatikana kila wakati. Ushindi Bet is an original Tanzanian sports-betting and casino platform in Swahili and English, using TZS and mobile-money — with clear withdrawal terms shown before deposit, bonus-only wagering, and responsible-gambling tools including deposit limits, cooldown and self-exclusion.</p><small>Ushindi Bet — Sandbox demo, no real money. 18+. Gaming Board of Tanzania licence required for real launch. Africa/Dar_es_Salaam · <RouterLink to="/responsible-gambling">Responsible Gambling</RouterLink> · <RouterLink to="/terms">Terms</RouterLink> · <RouterLink to="/privacy">Privacy</RouterLink></small></footer>
</template>
