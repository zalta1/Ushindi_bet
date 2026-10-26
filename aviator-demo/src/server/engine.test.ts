import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DemoEngine } from './engine.ts'
import { DEMO_CLIENT_SEED, DEMO_MAX_MULTIPLIER, DEMO_RTP_PCT, crashHash, crashPointFromHash, sha256 } from './fairness.ts'
import { createApp } from './index.ts'

function harness(opts?: { seeds?: string[], random?: () => number, bots?: boolean }) {
  let clock = 1_000_000
  let i = 0
  const seeds = opts?.seeds ?? ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e']
  const engine = new DemoEngine({
    now: () => clock,
    random: opts?.random ?? (() => 0.99),
    seed: () => {
      const value = seeds[i] ?? `seed-${i}`
      i += 1
      return value
    },
    bots: opts?.bots ?? false,
  })
  return {
    engine,
    advance(ms: number, step = 50) {
      const end = clock + ms
      while (clock < end) {
        clock = Math.min(end, clock + step)
        engine.tick()
      }
    },
  }
}

function nextRound(h: ReturnType<typeof harness>) {
  const start = h.engine.round.roundNo
  for (let n = 0; n < 20000; n += 1) {
    h.advance(100)
    if (h.engine.round.roundNo > start && h.engine.round.phase === 'betting') return
  }
  throw new Error(`round ${start} did not finish`)
}

function untilCrashed(h: ReturnType<typeof harness>) {
  const no = h.engine.round.roundNo
  for (let n = 0; n < 20000; n += 1) {
    h.advance(50)
    if (h.engine.round.roundNo !== no) throw new Error('skipped the crashed phase')
    if (h.engine.round.phase === 'crashed') return
  }
  throw new Error('did not crash')
}

function expectedCrash(seed: string, nonce: number) {
  return crashPointFromHash(crashHash(seed, DEMO_CLIENT_SEED, nonce), DEMO_RTP_PCT, DEMO_MAX_MULTIPLIER)
}

test('automatic crash matches the hash and stays hidden until the round ends', () => {
  const h = harness({ seeds: ['alpha-seed'] })
  const round = h.engine.round
  assert.equal(round.mode, 'automatic')
  assert.equal(round.serverSeed, 'alpha-seed')
  assert.equal(round.serverSeedHash, sha256('alpha-seed'))
  assert.equal(round.crashPoint, expectedCrash('alpha-seed', round.nonce))
  const view = h.engine.playerView()
  assert.equal(view.banner, 'DEMO - no real money')
  assert.equal(view.crashPoint, null)
  assert.equal(view.serverSeed, null)
  assert.equal(JSON.stringify(view).includes('alpha-seed'), false)
  assert.equal('plan' in view, false)
  assert.equal('log' in view, false)
  assert.equal(h.engine.adminView().current.crashPoint, null)
})

test('a manual plan waits for the next round', () => {
  const h = harness()
  const before = h.engine.round.crashPoint
  h.engine.setNext({ crash: 3.25, takeoffMs: 1000, flyAwayMs: 1200 })
  assert.equal(h.engine.round.crashPoint, before)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.plan.mode, 'manual')
  assert.equal(h.engine.plan.crash, 3.25)
  nextRound(h)
  assert.equal(h.engine.round.mode, 'manual')
  assert.equal(h.engine.round.crashPoint, 3.25)
  assert.equal(h.engine.round.takeoffMs, 1000)
  assert.equal(h.engine.round.flyAwayMs, 1200)
  assert.equal(h.engine.playerView().crashPoint, null)
  assert.equal(JSON.stringify(h.engine.playerView()).includes(h.engine.round.serverSeed), false)
  assert.equal(h.engine.adminView().current.crashPoint, 3.25)
  h.engine.setNext({ crash: 9 })
  assert.equal(h.engine.round.crashPoint, 3.25)
})

test('marked player cashes before the crash and an unmarked high auto loses', () => {
  const h = harness()
  const aminaStart = h.engine.players.get('bot-amina')!.balance
  const barakaStart = h.engine.players.get('bot-baraka')!.balance
  h.engine.setNext({ crash: 2, takeoffMs: 1000, flyAwayMs: 0 })
  h.engine.markWinners(['bot-amina'])
  assert.equal(h.engine.round.mode, 'automatic')
  nextRound(h)
  h.engine.placeBet('bot-amina', 1000, null, 1)
  h.engine.placeBet('bot-baraka', 1000, 5, 1)
  untilCrashed(h)
  const amina = h.engine.round.bets.find((bet) => bet.playerId === 'bot-amina')!
  const baraka = h.engine.round.bets.find((bet) => bet.playerId === 'bot-baraka')!
  assert.equal(h.engine.round.crashPoint, 2)
  assert.equal(amina.status, 'cashed')
  assert.equal(amina.cashoutAt, 1.99)
  assert.ok(amina.cashoutAt < h.engine.round.crashPoint)
  assert.equal(amina.payout, 1990)
  assert.equal(h.engine.players.get('bot-amina')!.balance, aminaStart - 1000 + 1990)
  assert.equal(baraka.status, 'lost')
  assert.equal(baraka.payout, 0)
  assert.equal(h.engine.players.get('bot-baraka')!.balance, barakaStart - 1000)
  const texts = h.engine.log.map((line) => line.text)
  const flew = texts.findIndex((line) => line.includes('flew away at 2.00x'))
  const cashed = texts.findIndex((line) => line.includes('Amina Juma cashed out at 1.99x'))
  assert.ok(flew >= 0 && cashed > flew)
  assert.equal(h.engine.playerView().serverSeed, 'seed-b')
  assert.equal(h.engine.playerView().crashPoint, 2)
})

test('fly-away timing cashes the marked player under the chosen crash', () => {
  const h = harness()
  h.engine.setNext({ crash: 2.5, takeoffMs: 1000, flyAwayMs: 800 })
  h.engine.markWinners(['bot-baraka'])
  nextRound(h)
  h.engine.placeBet('bot-baraka', 500, 1.2, 1)
  untilCrashed(h)
  const bet = h.engine.round.bets.find((item) => item.playerId === 'bot-baraka')!
  assert.equal(bet.marked, true)
  assert.equal(bet.auto, null)
  assert.equal(bet.status, 'cashed')
  assert.equal(bet.cashoutAt, 2.49)
  assert.equal(bet.payout, 1245)
  assert.equal(h.engine.round.crashPoint, 2.5)
  const flight = (h.engine.round.crashedAt ?? 0) - (h.engine.round.flightStartedAt ?? 0)
  assert.ok(flight >= 800 && flight <= 850)
})

test('automatic clears the queued crash and winners for the following round', () => {
  const h = harness({ seeds: ['s1', 's2', 's3'] })
  const openCrash = h.engine.round.crashPoint
  h.engine.setNext({ crash: 5, takeoffMs: 1000, flyAwayMs: 1000 })
  h.engine.markWinners(['bot-amina'])
  h.engine.automatic()
  assert.equal(h.engine.plan.mode, 'automatic')
  assert.deepEqual(h.engine.plan.winnerIds, [])
  assert.equal(h.engine.plan.crash, null)
  assert.equal(h.engine.plan.flyAwayMs, 0)
  assert.equal(h.engine.plan.takeoffMs, 5000)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.round.crashPoint, openCrash)
  nextRound(h)
  assert.equal(h.engine.round.serverSeed, 's2')
  assert.equal(h.engine.round.mode, 'automatic')
  assert.deepEqual(h.engine.round.winnerIds, [])
  assert.equal(h.engine.round.crashPoint, expectedCrash('s2', h.engine.round.nonce))
  assert.equal(h.engine.round.flyAwayMs, 0)
})

test('bots bet fake credit, and marked bots still bet when others sit out', () => {
  const busy = harness({ random: () => 0, bots: true })
  assert.equal(busy.engine.round.bets.length, 8)
  for (const bet of busy.engine.round.bets) {
    const player = busy.engine.players.get(bet.playerId)
    assert.equal(player?.bot, true)
    assert.ok((player?.balance ?? -1) >= 0)
  }

  const quiet = harness({ random: () => 0.99, bots: true })
  assert.equal(quiet.engine.round.bets.length, 0)
  quiet.engine.setNext({ crash: 2, takeoffMs: 1000, flyAwayMs: 500 })
  quiet.engine.markWinners(['bot-amina', 'bot-neema'])
  nextRound(quiet)
  const ids = quiet.engine.round.bets.map((bet) => bet.playerId).sort()
  assert.deepEqual(ids, ['bot-amina', 'bot-neema'])
  assert.equal(quiet.engine.round.bets.every((bet) => bet.marked && bet.stake === 1000), true)
})

test('demo login gives fake credit and rejects a digit in the name', () => {
  const h = harness()
  const session = h.engine.login('Asha Demo')
  assert.equal(session.player.balance, 100_000)
  assert.equal(session.player.bot, false)
  assert.throws(() => h.engine.login('Asha 1'), /invalid_name/)
  h.engine.placeBet(session.player.id, 500, null, 1)
  assert.equal(session.player.balance, 99_500)
})

test('http demo does not reveal the seed and does not use the real session cookie', async () => {
  const { app, engine } = await createApp(new DemoEngine({
    now: () => 5_000,
    random: () => 0.99,
    seed: () => 'http-seed',
    bots: false,
  }))
  const health = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(health.statusCode, 200)
  assert.deepEqual(health.json(), { ok: true, demo: true })

  const state = await app.inject({ method: 'GET', url: '/api/state' })
  assert.equal(state.json().banner, 'DEMO - no real money')
  assert.equal(state.json().serverSeed, null)
  assert.equal(state.json().crashPoint, null)
  assert.equal(JSON.stringify(state.json()).includes('http-seed'), false)

  const bad = await app.inject({ method: 'POST', url: '/api/admin/plan', payload: { crash: 1.01 } })
  assert.equal(bad.statusCode, 400)
  assert.equal(engine.round.mode, 'automatic')

  const plan = await app.inject({
    method: 'POST',
    url: '/api/admin/plan',
    payload: { crash: 2.5, takeoffMs: 4000, flyAwayMs: 6000 },
  })
  assert.equal(plan.statusCode, 200)
  assert.equal(engine.round.mode, 'automatic')
  assert.equal(engine.round.crashPoint, crashPointFromHash(crashHash('http-seed', DEMO_CLIENT_SEED, 0), DEMO_RTP_PCT, DEMO_MAX_MULTIPLIER))
  assert.equal(engine.plan.crash, 2.5)
  assert.equal(plan.json().current.crashPoint, null)

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { name: 'Asha Demo' } })
  const cookie = String(login.headers['set-cookie'])
  assert.match(cookie, /aviator_demo=/)
  assert.equal(cookie.includes('ushindi'), false)
  const bet = await app.inject({
    method: 'POST',
    url: '/api/bet',
    headers: { cookie },
    payload: { stake: 500, panel: 1 },
  })
  assert.equal(bet.statusCode, 200)
  assert.equal(bet.json().balance, 99_500)

  const auto = await app.inject({ method: 'POST', url: '/api/admin/automatic' })
  assert.equal(auto.statusCode, 200)
  assert.equal(auto.json().plan.mode, 'automatic')
  assert.equal(engine.round.crashPoint, crashPointFromHash(crashHash('http-seed', DEMO_CLIENT_SEED, 0), DEMO_RTP_PCT, DEMO_MAX_MULTIPLIER))
  await app.close()
})

test('demo sources do not import the real app', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const banned = ['ushindi_sid', 'DATABASE_URL', '@ushindi', 'apps/api', 'apps/web', "from 'pg'", 'from "pg"', 'postgres://', 'createPool']
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|vue|css)$/.test(name) && !name.endsWith('.test.ts')) files.push(full)
    }
  }
  walk(path.join(root, 'src'))
  assert.ok(files.length > 4)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const word of banned) assert.equal(text.includes(word), false, `${path.relative(root, file)} contains ${word}`)
  }
})
