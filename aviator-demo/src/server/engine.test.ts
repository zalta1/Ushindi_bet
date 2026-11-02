import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DemoEngine, nairobiClock } from './engine.ts'
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

function tenOdds(crash = 1.2, capSec = 8) {
  return {
    capSec,
    entries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ crash: Math.round((crash + i * 0.1) * 100) / 100, winnerIds: [] as string[] })),
  }
}

test('odds schedule plays each odd in order, then returns to automatic', () => {
  const h = harness({ seeds: ['sched-a', 'sched-b', 'sched-c', 'sched-d'] })
  const before = h.engine.round.crashPoint
  const plan = tenOdds(1.2, 8)
  assert.throws(() => h.engine.startSchedule({ capSec: 3, entries: [] }), /schedule_too_short/)
  assert.throws(() => h.engine.startSchedule({ capSec: 3, entries: plan.entries.map((entry, i) => i === 3 ? { crash: 0.4, winnerIds: [] } : entry) }), /schedule_odd_invalid/)
  assert.throws(() => h.engine.startSchedule({ capSec: 0.1, entries: plan.entries }), /schedule_cap_invalid/)
  h.engine.startSchedule(plan)
  assert.equal(h.engine.round.crashPoint, before)
  assert.equal(h.engine.round.mode, 'automatic')
  const seen: number[] = []
  for (let i = 0; i < 10; i += 1) {
    nextRound(h)
    seen.push(h.engine.round.crashPoint)
    assert.equal(h.engine.adminView().schedule.progress, `Schedule round ${i + 1} of 10`)
  }
  assert.deepEqual(seen, plan.entries.map((entry) => entry.crash))
  const texts = () => h.engine.log.map((line) => line.text).join('\n')
  assert.match(texts(), /Round \d+ opened · schedule 1\/10 · 1\.20x/)
  assert.match(texts(), /Round \d+ opened · schedule 10\/10 · 2\.10x/)
  nextRound(h)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.schedule.status, 'idle')
  assert.equal(h.engine.round.crashPoint, expectedCrash(h.engine.round.serverSeed, h.engine.round.nonce))
  assert.match(texts(), /Odds schedule finished/)
  assert.match(texts(), /Next round returned to automatic/)
})

test('time cap shortens a long flight and leaves a short odd on the natural curve', () => {
  const h = harness()
  const entries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ crash: i === 0 ? 30 : 1.05, winnerIds: [] as string[] }))
  h.engine.startSchedule({ capSec: 2, entries })
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 30)
  assert.equal(h.engine.round.flyAwayMs, 2000)
  untilCrashed(h)
  const flight = (h.engine.round.crashedAt ?? 0) - (h.engine.round.flightStartedAt ?? 0)
  assert.ok(flight >= 2000 && flight <= 2100)
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 1.05)
  assert.equal(h.engine.round.flyAwayMs, 0)
})

test('a schedule row can mark winners, and pause holds the next odd', () => {
  const h = harness()
  const entries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
    crash: 2,
    winnerIds: i === 0 ? ['bot-amina'] : [],
  }))
  h.engine.startSchedule({ capSec: 3, entries })
  nextRound(h)
  h.engine.placeBet('bot-amina', 1000, 5, 1)
  untilCrashed(h)
  const amina = h.engine.round.bets.find((bet) => bet.playerId === 'bot-amina')!
  assert.equal(amina.status, 'cashed')
  assert.equal(amina.cashoutAt, 1.99)
  assert.ok(amina.cashoutAt < h.engine.round.crashPoint)
  h.engine.pauseSchedule()
  h.advance(5000)
  assert.equal(h.engine.round.phase, 'crashed')
  assert.equal(h.engine.schedule.cursor, 1)
  h.engine.resumeSchedule()
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 2)
  assert.equal(h.engine.round.scheduleIndex, 1)
  h.engine.stopSchedule()
  nextRound(h)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.round.crashPoint, expectedCrash(h.engine.round.serverSeed, h.engine.round.nonce))
  assert.match(h.engine.log.map((line) => line.text).join('\n'), /Odds schedule stopped/)
})

test('a single next-round plan still wins once while a schedule is running', () => {
  const h = harness()
  h.engine.startSchedule(tenOdds())
  h.engine.setNext({ crash: 9, takeoffMs: 1000, flyAwayMs: 1000 })
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 9)
  assert.equal(h.engine.round.scheduleIndex, null)
  assert.equal(h.engine.schedule.cursor, 0)
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 1.2)
  assert.equal(h.engine.round.scheduleIndex, 0)
})

function clockHarness(start = Date.parse('2026-11-02T17:00:00.000Z')) {
  let clock = start
  let i = 0
  const engine = new DemoEngine({
    now: () => clock,
    random: () => 0.99,
    seed: () => {
      const value = `seed-${i}`
      i += 1
      return value
    },
    bots: false,
  })
  return {
    engine,
    get clock() { return clock },
    advance(ms: number, step = 50) {
      const end = clock + ms
      while (clock < end) {
        clock = Math.min(end, clock + step)
        engine.tick()
      }
    },
  }
}

test('one Nairobi start time arms the list, estimates each odd, and rejects a past time', () => {
  const h = clockHarness()
  const past = nairobiClock(h.clock - 5_000)
  const start = nairobiClock(h.clock + 20_000)
  assert.throws(() => h.engine.startSchedule({
    mode: 'timed',
    capSec: 2,
    startAt: past,
    entries: [{ crash: 2, winnerIds: [] }],
  }), /schedule_time_past/)
  assert.throws(() => h.engine.startSchedule({ mode: 'sequence', capSec: 2, entries: [] }), /schedule_too_short/)
  h.engine.startSchedule({
    mode: 'timed',
    capSec: 2,
    startAt: start,
    entries: [{ crash: 2, winnerIds: [] }, { crash: 5.5, winnerIds: [] }, { crash: 1.4, winnerIds: [] }],
  })
  assert.equal(h.engine.schedule.status, 'armed')
  assert.equal(h.engine.round.mode, 'automatic')
  const view = h.engine.adminView().schedule
  assert.equal(view.entries.length, 3)
  assert.equal(view.entries[0].at, start)
  assert.notEqual(view.entries[1].at, view.entries[0].at)
  assert.match(view.countdown, new RegExp(`First odd 2\\.00x at ${start}`))
  assert.match(view.progress, /Saved · starts at/)
})

test('a flying round delays the first odd, then the rest run back to back', () => {
  const h = clockHarness()
  h.engine.setNext({ crash: 4, takeoffMs: 1000, flyAwayMs: 6000 })
  nextRound(h)
  const plannedMs = h.clock + 2_000
  const planned = nairobiClock(plannedMs)
  h.engine.startSchedule({
    mode: 'timed',
    capSec: 2,
    startAt: planned,
    entries: [{ crash: 30, winnerIds: [] }, { crash: 1.4, winnerIds: [] }],
  })
  h.advance(1_000)
  assert.equal(h.engine.round.phase, 'flying')
  h.advance(2_500)
  assert.equal(h.engine.round.phase, 'flying')
  assert.equal(h.engine.round.crashPoint, 4)
  assert.equal(h.engine.schedule.status, 'armed')
  untilCrashed(h)
  h.advance(200)
  assert.equal(h.engine.round.crashPoint, 30)
  assert.equal(h.engine.round.flyAwayMs, 2000)
  assert.equal(h.engine.schedule.status, 'running')
  const log = h.engine.log.map((line) => line.text).join('\n')
  assert.match(log, new RegExp(`planned ${planned} · launched`))
  assert.match(log, /delayed/)
  nextRound(h)
  assert.equal(h.engine.round.crashPoint, 1.4)
  assert.equal(h.engine.round.scheduleIndex, 1)
  nextRound(h)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.schedule.status, 'idle')
  assert.match(h.engine.log.map((line) => line.text).join('\n'), /Odds schedule finished/)
  assert.match(h.engine.log.map((line) => line.text).join('\n'), /Next round returned to automatic/)
})

test('before the start time, automatic rounds continue, then an imminent list waits and launches on time', () => {
  const h = clockHarness()
  h.engine.startSchedule({
    mode: 'timed',
    capSec: 2,
    startAt: nairobiClock(h.clock + 10 * 60_000),
    entries: [{ crash: 2, winnerIds: [] }],
  })
  nextRound(h)
  assert.equal(h.engine.round.mode, 'automatic')
  assert.equal(h.engine.schedule.status, 'armed')
  assert.equal(h.engine.schedule.cursor, 0)

  const quiet = clockHarness()
  untilCrashed(quiet)
  const plannedMs = quiet.clock + 4_000
  const planned = nairobiClock(plannedMs)
  quiet.engine.startSchedule({
    mode: 'timed',
    capSec: 2,
    startAt: planned,
    entries: [{ crash: 2, winnerIds: [] }, { crash: 3, winnerIds: [] }],
  })
  quiet.advance(1_500)
  assert.equal(quiet.engine.round.phase, 'crashed')
  quiet.advance(3_000)
  assert.equal(quiet.engine.round.crashPoint, 2)
  const opened = quiet.engine.log.map((line) => line.text).find((line) => line.includes('schedule 1/2'))
  assert.match(opened ?? '', new RegExp(`planned ${planned} · launched ${planned}`))
  assert.equal((opened ?? '').includes('delayed'), false)
  nextRound(quiet)
  assert.equal(quiet.engine.round.crashPoint, 3)
  assert.equal(quiet.engine.round.scheduleIndex, 1)
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
