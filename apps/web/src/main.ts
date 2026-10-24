import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './style.css'
import { i18n } from './i18n'
import Home from './views/Home.vue'
import Live from './views/Live.vue'
import Match from './views/Match.vue'
import Jackpots from './views/Jackpots.vue'
import Virtuals from './views/Virtuals.vue'
import Casino from './views/Casino.vue'
import Aviator from './views/Aviator.vue'
import Dice from './views/Dice.vue'
import Mines from './views/Mines.vue'
import Mayan from './views/Mayan.vue'
import AviatorFair from './views/AviatorFair.vue'
import Promotions from './views/Promotions.vue'
import Search from './views/Search.vue'
import Auth from './views/Auth.vue'
import SetPassword from './views/SetPassword.vue'
import Profile from './views/Profile.vue'
import Money from './views/Money.vue'
import Transactions from './views/Transactions.vue'
import MyBets from './views/MyBets.vue'
import RG from './views/RG.vue'
import Legal from './views/Legal.vue'
import Admin from './views/Admin.vue'
import NotFound from './views/NotFound.vue'
import Livescore from './views/Livescore.vue'
import FixturesPrint from './views/FixturesPrint.vue'
import { useAuth } from './stores/store'

const routes = [
  { path: '/', component: Home },
  { path: '/live', component: Live },
  { path: '/match/:id', component: Match },
  { path: '/jackpots', component: Jackpots },
  { path: '/virtuals', component: Virtuals },
  { path: '/casino', component: Casino },
  { path: '/aviator', component: Aviator },
  { path: '/dice', component: Dice },
  { path: '/mines', component: Mines },
  { path: '/mayan', component: Mayan },
  { path: '/aviator/fair', component: AviatorFair },
  { path: '/crash', redirect: '/aviator' },
  { path: '/promotions', component: Promotions },
  { path: '/search', component: Search },
  { path: '/login', component: Auth },
  { path: '/register', component: Auth },
  { path: '/forgot', component: Auth },
  { path: '/set-password', component: SetPassword },
  { path: '/profile', component: Profile },
  { path: '/deposit', component: Money },
  { path: '/withdraw', component: Money },
  { path: '/transactions', component: Transactions },
  { path: '/my-bets', component: MyBets },
  { path: '/responsible-gambling', component: RG },
  { path: '/terms', component: Legal },
  { path: '/privacy', component: Legal },
  { path: '/admin', component: Admin },
  { path: '/livescore', component: Livescore },
  { path: '/fixtures/print', component: FixturesPrint },
  { path: '/:pathMatch(.*)*', component: NotFound },
]

const pinia = createPinia()
const router = createRouter({ history: createWebHistory(), routes })
router.beforeEach(async (to) => {
  const auth = useAuth(pinia)
  if (!auth.bootstrapped) await auth.bootstrap()
  const mustChange = Boolean(auth.user?.mustChangePassword)
  if (mustChange && to.path !== '/set-password') return { path: '/set-password' }
  if (to.path === '/set-password') {
    if (!auth.user) return { path: '/login', query: { next: '/set-password' } }
    if (!mustChange) return { path: '/' }
  }
  if (to.path === '/admin' && !auth.user) return { path: '/login', query: { next: to.fullPath } }
})

const app = createApp(App)
app.use(pinia)
app.use(i18n)
app.use(router)
void router.isReady().then(() => {
  app.mount('#app')
})
