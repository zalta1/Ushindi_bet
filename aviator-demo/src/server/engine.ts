import { randomBytes } from 'node:crypto'
import {
  DEMO_CLIENT_SEED,
  DEMO_MAX_MULTIPLIER,
  DEMO_RTP_PCT,
  avatarColor,
  cents,
  crashHash,
  crashPointFromHash,
  initials,
  multiplierAt,
  payoutOf,
  secondsFor,
  sha256,
} from './fairness.js'

export const DEMO_CREDIT = 100_000
export const MIN_STAKE = 100
export const MAX_STAKE = 100_000
export const DEFAULT_TAKEOFF_MS = 5_000
export const DEFAULT_CRASHED_MS = 2_500
export const SCHEDULE_TAKEOFF_MS = 1_500
export const SCHEDULE_GAP_MS = 1_000
export const MIN_SCHEDULE_ODDS = 10
export const IMMINENT_MS = 12_000
export const ON_TIME_MS = 1_500
export const NAIROBI_ZONE = 'Africa/Nairobi'
export const BANNER = 'DEMO - no real money'

export const BOTS: { id: string, name: string, balance: number }[] = [
  { id: 'bot-amina', name: 'Amina Juma', balance: 84_200 },
  { id: 'bot-baraka', name: 'Baraka Mushi', balance: 126_500 },
  { id: 'bot-neema', name: 'Neema Lyimo', balance: 53_400 },
  { id: 'bot-juma', name: 'Juma Hassan', balance: 210_000 },
  { id: 'bot-fatuma', name: 'Fatuma Said', balance: 67_800 },
  { id: 'bot-kelvin', name: 'Kelvin Mwangi', balance: 99_000 },
  { id: 'bot-rehema', name: 'Rehema Peter', balance: 157_300 },
  { id: 'bot-omari', name: 'Omari Salim', balance: 41_200 },
]

export type Phase = 'betting' | 'flying' | 'crashed'
export type Mode = 'automatic' | 'manual'

export interface Player {
  id: string
  name: string
  balance: number
  bot: boolean
  token?: string
}

export interface Bet {
  id: string
  playerId: string
  name: string
  panel: number
  stake: number
  auto: number | null
  marked: boolean
  status: 'active' | 'cashed' | 'lost'
  cashoutAt: number | null
  payout: number
}

export interface Round {
  roundNo: number
  nonce: number
  phase: Phase
  mode: Mode
  serverSeed: string
  serverSeedHash: string
  crashPoint: number
  takeoffMs: number
  flyAwayMs: number
  winnerIds: string[]
  scheduleIndex: number | null
  scheduleTotal: number
  bettingEndsAt: number
  flightStartedAt: number | null
  crashedAt: number | null
  bets: Bet[]
}

export interface Plan {
  mode: Mode
  crash: number | null
  takeoffMs: number
  flyAwayMs: number
  winnerIds: string[]
}

export interface ScheduleEntry {
  crash: number
  winnerIds: string[]
  atMs: number | null
}

export type ScheduleStatus = 'idle' | 'running' | 'paused'
export type ScheduleMode = 'sequence' | 'timed'

/** Fly long enough to hit the odd, but never longer than the cap. */
export function scheduleFlyAwayMs(crash: number, capMs: number): number {
  const natural = secondsFor(Math.max(1, crash)) * 1000
  if (natural <= capMs) return 0
  return Math.round(capMs)
}

export function nairobiClock(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: NAIROBI_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${pick('hour')}:${pick('minute')}:${pick('second')}`
}

export function nairobiDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NAIROBI_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
}

/** Interpret HH:MM:SS as Africa/Nairobi wall time on the Nairobi calendar day of nowMs. */
export function nairobiEpoch(hms: string, nowMs: number): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hms.trim())
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  const ss = Number(match[3] ?? '0')
  if (hh > 23 || mm > 59 || ss > 59) return null
  const clock = [hh, mm, ss].map((part) => String(part).padStart(2, '0')).join(':')
  const at = Date.parse(`${nairobiDate(nowMs)}T${clock}+03:00`)
  return Number.isFinite(at) ? at : null
}

function formatSpan(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  return [hh, mm, ss].map((part) => String(part).padStart(2, '0')).join(':')
}

export interface LogLine {
  id: number
  at: number
  kind: 'round' | 'bet' | 'cashout'
  text: string
}

export interface EngineOptions {
  now?: () => number
  random?: () => number
  seed?: () => string
  bots?: boolean
}

export function httpError(status: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: status })
}

function winnerTarget(crash: number): number {
  const raw = cents(crash) - 1
  const target = Math.max(101, raw)
  return target / 100
}

export class DemoEngine {
  readonly players = new Map<string, Player>()
  private readonly tokens = new Map<string, string>()
  private readonly now: () => number
  private readonly random: () => number
  private readonly seed: () => string
  private readonly botsOn: boolean
  private nonce = 0
  private betSeq = 1
  private logSeq = 1

  round!: Round
  plan: Plan = {
    mode: 'automatic',
    crash: null,
    takeoffMs: DEFAULT_TAKEOFF_MS,
    flyAwayMs: 0,
    winnerIds: [],
  }
  history: { roundNo: number, crashPoint: number, mode: Mode }[] = []
  log: LogLine[] = []
  schedule: {
    status: ScheduleStatus
    mode: ScheduleMode
    capMs: number
    cursor: number
    entries: ScheduleEntry[]
    finished: boolean
    dueIndex: number | null
  } = {
    status: 'idle',
    mode: 'sequence',
    capMs: 3_000,
    cursor: 0,
    entries: [],
    finished: false,
    dueIndex: null,
  }
  private overrideOnce = false

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.seed = options.seed ?? (() => randomBytes(32).toString('hex'))
    this.botsOn = options.bots !== false
    for (const bot of BOTS) this.players.set(bot.id, { ...bot, bot: true })
    this.openRound()
  }

  tick(): void {
    this.markTimedDue()
    const now = this.now()
    const round = this.round
    if (round.phase === 'betting') {
      if (now < round.bettingEndsAt) return
      round.phase = 'flying'
      round.flightStartedAt = now
    }
    if (round.phase === 'flying') {
      const m = this.multiplierNow(now)
      const target = winnerTarget(round.crashPoint)
      for (const bet of round.bets) {
        if (bet.status !== 'active') continue
        if (bet.marked && m >= target) this.cash(bet, target)
        else if (bet.auto != null && cents(bet.auto) < cents(round.crashPoint) && m >= bet.auto) this.cash(bet, bet.auto)
      }
      if (this.shouldCrash(now, m)) {
        for (const bet of round.bets) {
          if (bet.status === 'active' && bet.marked) this.cash(bet, target)
        }
        for (const bet of round.bets) {
          if (bet.status === 'active') this.lose(bet)
        }
        round.phase = 'crashed'
        round.crashedAt = now
        this.history.unshift({ roundNo: round.roundNo, crashPoint: round.crashPoint, mode: round.mode })
        if (this.history.length > 24) this.history.length = 24
        const tag = round.scheduleIndex == null
          ? round.mode
          : `schedule ${round.scheduleIndex + 1}/${round.scheduleTotal}`
        this.pushLog('round', `Round ${round.roundNo} flew away at ${round.crashPoint.toFixed(2)}x · ${tag} · nonce ${round.nonce} · seed ${round.serverSeed}`)
      }
      return
    }
    if (round.phase === 'crashed' && round.crashedAt != null) {
      if (this.timedDueNow()) {
        if (!(this.schedule.status === 'paused' && !this.overrideOnce)) this.openRound()
        return
      }
      const gap = this.schedule.status === 'running' ? SCHEDULE_GAP_MS : DEFAULT_CRASHED_MS
      if (now < round.crashedAt + gap) return
      if (this.schedule.status === 'paused' && round.scheduleIndex != null && !this.overrideOnce) return
      if (this.idleForNextTimed(now)) return
      this.openRound()
    }
  }

  login(name: string): { token: string, player: Player } {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!/^[\p{L}][\p{L} .'-]{0,31}$/u.test(clean)) throw httpError(400, 'invalid_name')
    const id = `demo-${randomBytes(4).toString('hex')}`
    const token = randomBytes(16).toString('hex')
    const player: Player = { id, name: clean, balance: DEMO_CREDIT, bot: false, token }
    this.players.set(id, player)
    this.tokens.set(token, id)
    this.pushLog('round', `${clean} entered the demo with ${DEMO_CREDIT} fake credit`)
    return { token, player }
  }

  placeBet(playerId: string, stake: number, auto: number | null, panel = 1): Bet {
    const player = this.players.get(playerId)
    if (!player) throw httpError(404, 'player_missing')
    if (this.round.phase !== 'betting') throw httpError(409, 'betting_closed')
    if (panel !== 1 && panel !== 2) throw httpError(400, 'panel_invalid')
    if (!Number.isSafeInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE) throw httpError(400, 'stake_out_of_range')
    let autoAt: number | null = null
    if (auto != null) {
      if (typeof auto !== 'number' || !Number.isFinite(auto) || auto < 1.01 || auto > DEMO_MAX_MULTIPLIER) {
        throw httpError(400, 'auto_out_of_range')
      }
      autoAt = cents(auto) / 100
    }
    if (this.round.bets.some((bet) => bet.playerId === playerId && bet.panel === panel)) {
      throw httpError(409, 'already_bet')
    }
    if (player.balance < stake) throw httpError(409, 'insufficient_demo_credit')
    player.balance -= stake
    const marked = this.round.mode === 'manual' && this.round.winnerIds.includes(playerId)
    const bet: Bet = {
      id: `b${this.betSeq++}`,
      playerId,
      name: player.name,
      panel,
      stake,
      auto: marked ? null : autoAt,
      marked,
      status: 'active',
      cashoutAt: null,
      payout: 0,
    }
    this.round.bets.push(bet)
    const autoText = bet.auto == null ? '' : ` · auto ${bet.auto.toFixed(2)}x`
    const markText = bet.marked ? ' · marked to win' : ''
    this.pushLog('bet', `${player.name} bet ${stake}${autoText}${markText}`)
    return bet
  }

  placeBetForToken(token: string | undefined, stake: number, auto: number | null, panel: number) {
    const player = this.playerByToken(token)
    const bet = this.placeBet(player.id, stake, auto, panel)
    return { balance: player.balance, betId: bet.id }
  }

  cashoutForToken(token: string | undefined, panel: number) {
    const player = this.playerByToken(token)
    if (this.round.phase !== 'flying') throw httpError(409, 'not_flying')
    const bet = this.round.bets.find((item) => item.playerId === player.id && item.panel === panel && item.status === 'active')
    if (!bet) throw httpError(404, 'no_bet')
    const m = this.multiplierNow(this.now())
    if (cents(m) < 101 || cents(m) >= cents(this.round.crashPoint)) throw httpError(409, 'cashout_closed')
    this.cash(bet, m)
    return { balance: player.balance, cashoutAt: bet.cashoutAt, payout: bet.payout }
  }

  /**
   * Queues crash, takeoff, and fly-away for the next round only.
   * The open round keeps the crash it was given when it opened.
   */
  setNext(input: { crash?: number, takeoffMs?: number, flyAwayMs?: number }): Plan {
    if (input.crash === undefined && input.takeoffMs === undefined && input.flyAwayMs === undefined) {
      throw httpError(400, 'empty_plan')
    }
    if (input.crash !== undefined) {
      if (typeof input.crash !== 'number' || !Number.isFinite(input.crash) || input.crash < 1.1 || input.crash > 100) {
        throw httpError(400, 'crash_out_of_range')
      }
      this.plan.crash = cents(input.crash) / 100
    }
    if (input.takeoffMs !== undefined) {
      if (typeof input.takeoffMs !== 'number' || !Number.isFinite(input.takeoffMs) || input.takeoffMs < 1000 || input.takeoffMs > 30_000) {
        throw httpError(400, 'takeoff_out_of_range')
      }
      this.plan.takeoffMs = Math.round(input.takeoffMs)
    }
    if (input.flyAwayMs !== undefined) {
      const fly = input.flyAwayMs
      if (typeof fly !== 'number' || !Number.isFinite(fly) || fly < 0 || (fly > 0 && fly < 500) || fly > 60_000) {
        throw httpError(400, 'flyaway_out_of_range')
      }
      this.plan.flyAwayMs = Math.round(fly)
    }
    this.plan.mode = 'manual'
    if (this.plan.crash == null) this.plan.crash = 2
    this.overrideOnce = true
    const flyText = this.plan.flyAwayMs === 0 ? 'natural' : `${(this.plan.flyAwayMs / 1000).toFixed(1)}s`
    this.pushLog('round', `Next round queued · manual · crash ${this.plan.crash.toFixed(2)}x · takeoff ${(this.plan.takeoffMs / 1000).toFixed(1)}s · fly away ${flyText}`)
    return this.plan
  }

  markWinners(ids: unknown): Plan {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw httpError(400, 'winners_invalid')
    const unique = [...new Set(ids)].filter((id) => this.players.has(id)).slice(0, 20)
    this.plan.mode = 'manual'
    if (this.plan.crash == null) this.plan.crash = 2
    this.plan.winnerIds = unique
    this.overrideOnce = true
    const names = unique.map((id) => this.players.get(id)?.name ?? id)
    this.pushLog('round', names.length ? `Next round winners · ${names.join(', ')}` : 'Next round winners cleared')
    return this.plan
  }

  /** The following round uses the hash. This round is left as it opened. */
  automatic(): Plan {
    if (this.schedule.status !== 'idle') {
      this.schedule.status = 'idle'
      this.schedule.cursor = 0
      this.schedule.finished = false
      this.schedule.dueIndex = null
      this.schedule.mode = 'sequence'
      this.pushLog('round', 'Odds schedule stopped')
    }
    this.overrideOnce = false
    this.plan = {
      mode: 'automatic',
      crash: null,
      takeoffMs: DEFAULT_TAKEOFF_MS,
      flyAwayMs: 0,
      winnerIds: [],
    }
    this.pushLog('round', 'Next round returned to automatic')
    return this.plan
  }

  startSchedule(raw: { capSec?: unknown, entries?: unknown, mode?: unknown }) {
    const capSec = Number(raw.capSec)
    if (!Number.isFinite(capSec) || capSec < 0.5 || capSec > 60) throw httpError(400, 'schedule_cap_invalid')
    if (!Array.isArray(raw.entries)) throw httpError(400, 'schedule_invalid')
    const mode: ScheduleMode = raw.mode === 'timed' ? 'timed' : 'sequence'
    if (mode === 'sequence' && raw.entries.length < MIN_SCHEDULE_ODDS) throw httpError(400, 'schedule_too_short')
    if (mode === 'timed' && raw.entries.length < 1) throw httpError(400, 'schedule_too_short')
    const now = this.now()
    const entries: ScheduleEntry[] = raw.entries.map((item) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const crash = Number(row.crash)
      if (!Number.isFinite(crash) || crash < 1 || crash > DEMO_MAX_MULTIPLIER) throw httpError(400, 'schedule_odd_invalid')
      const ids = Array.isArray(row.winnerIds) ? row.winnerIds : []
      if (ids.some((id) => typeof id !== 'string')) throw httpError(400, 'winners_invalid')
      let atMs: number | null = null
      if (mode === 'timed') {
        const at = nairobiEpoch(String(row.at ?? ''), now)
        if (at == null) throw httpError(400, 'schedule_time_invalid')
        if (at < now) throw httpError(400, 'schedule_time_past')
        atMs = at
      }
      return {
        crash: cents(crash) / 100,
        winnerIds: [...new Set(ids.filter((id): id is string => this.players.has(id)))].slice(0, 20),
        atMs,
      }
    })
    if (mode === 'timed') {
      const seen = new Set<number>()
      for (const entry of entries) {
        const at = entry.atMs ?? 0
        if (seen.has(at)) throw httpError(400, 'schedule_time_duplicate')
        seen.add(at)
      }
      entries.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
    }
    this.schedule = { status: 'running', mode, capMs: Math.round(capSec * 1000), cursor: 0, entries, finished: false, dueIndex: null }
    this.overrideOnce = false
    const list = entries.map((entry) => (
      entry.atMs == null ? `${entry.crash.toFixed(2)}x` : `${entry.crash.toFixed(2)}x at ${nairobiClock(entry.atMs)}`
    )).join(', ')
    this.pushLog('round', `Odds schedule started · ${mode} · ${entries.length} odds · time cap ${capSec.toFixed(1)}s · ${list}`)
  }

  pauseSchedule() {
    if (this.schedule.status !== 'running') throw httpError(409, 'schedule_not_running')
    this.schedule.status = 'paused'
    const next = Math.min(this.schedule.cursor + 1, this.schedule.entries.length)
    this.pushLog('round', `Odds schedule paused · next ${next} of ${this.schedule.entries.length}`)
  }

  resumeSchedule() {
    if (this.schedule.status !== 'paused') throw httpError(409, 'schedule_not_paused')
    this.schedule.status = 'running'
    const next = Math.min(this.schedule.cursor + 1, this.schedule.entries.length)
    this.pushLog('round', `Odds schedule resumed · next ${next} of ${this.schedule.entries.length}`)
  }

  stopSchedule() {
    if (this.schedule.status === 'idle') return
    this.automatic()
  }

  playerView(token?: string | null) {
    const now = this.now()
    const round = this.round
    const you = token ? this.players.get(this.tokens.get(token) ?? '') : undefined
    return {
      banner: BANNER,
      phase: round.phase,
      multiplier: this.publicMultiplier(now),
      countdownMs: round.phase === 'betting' ? Math.max(0, round.bettingEndsAt - now) : 0,
      roundNo: round.roundNo,
      mode: round.mode,
      serverSeedHash: round.serverSeedHash,
      serverSeed: round.phase === 'crashed' ? round.serverSeed : null,
      crashPoint: round.phase === 'crashed' ? round.crashPoint : null,
      nonce: round.nonce,
      history: this.history.map((item) => ({ roundNo: item.roundNo, crashPoint: item.crashPoint })),
      viewerCount: this.players.size,
      limits: { minStake: MIN_STAKE, maxStake: MAX_STAKE, rtpPct: DEMO_RTP_PCT },
      bets: round.bets.map((bet) => this.publicBet(bet)),
      you: you
        ? {
          id: you.id,
          name: you.name,
          balance: you.balance,
          bets: round.bets.filter((bet) => bet.playerId === you.id).map((bet) => this.publicBet(bet)),
        }
        : null,
    }
  }

  adminView() {
    const now = this.now()
    const round = this.round
    const reveal = round.mode === 'manual' || round.phase === 'crashed'
    let flyLeftMs: number | null = null
    if (round.phase === 'flying' && round.flyAwayMs > 0 && round.flightStartedAt != null) {
      flyLeftMs = Math.max(0, round.flightStartedAt + round.flyAwayMs - now)
    }
    return {
      ...this.playerView(null),
      serverSeed: round.phase === 'crashed' ? round.serverSeed : null,
      crashPoint: round.phase === 'crashed' ? round.crashPoint : null,
      current: {
        roundNo: round.roundNo,
        phase: round.phase,
        mode: round.mode,
        crashPoint: reveal ? round.crashPoint : null,
        takeoffMs: round.takeoffMs,
        flyAwayMs: round.flyAwayMs,
        flyLeftMs,
        winnerIds: round.winnerIds,
        scheduleIndex: round.scheduleIndex,
        scheduleTotal: round.scheduleTotal,
      },
      schedule: this.scheduleView(),
      plan: {
        ...this.plan,
        winnerNames: this.plan.winnerIds.map((id) => this.players.get(id)?.name ?? id),
      },
      players: [...this.players.values()].map((player) => {
        const bet = round.bets.find((item) => item.playerId === player.id) ?? null
        return {
          id: player.id,
          name: player.name,
          balance: player.balance,
          bot: player.bot,
          color: avatarColor(player.id),
          initials: initials(player.name),
          bet: bet
            ? {
              stake: bet.stake,
              auto: bet.auto,
              status: bet.status,
              cashoutAt: bet.cashoutAt,
              payout: bet.payout,
              marked: bet.marked,
              panel: bet.panel,
            }
            : null,
        }
      }),
      log: this.log,
      nairobiNow: nairobiClock(now),
    }
  }

  private openRound() {
    const nonce = this.nonce
    this.nonce += 1
    const serverSeed = this.seed()
    const hashInput = crashHash(serverSeed, DEMO_CLIENT_SEED, nonce)
    const hashed = crashPointFromHash(hashInput, DEMO_RTP_PCT, DEMO_MAX_MULTIPLIER)
    let mode: Mode = this.plan.mode
    let crashPoint = hashed
    let takeoffMs = DEFAULT_TAKEOFF_MS
    let flyAwayMs = 0
    let winnerIds: string[] = []
    let scheduleIndex: number | null = null
    let launchNote = ''
    const scheduleTotal = this.schedule.entries.length

    if (this.overrideOnce) {
      this.overrideOnce = false
      if (mode === 'manual') {
        crashPoint = this.plan.crash ?? 2
        takeoffMs = this.plan.takeoffMs
        flyAwayMs = this.plan.flyAwayMs
        winnerIds = [...this.plan.winnerIds]
      }
    } else if (this.schedule.status === 'running') {
      const due = this.schedule.mode === 'sequence' || this.timedDueNow()
      if (this.schedule.cursor >= this.schedule.entries.length) {
        this.finishSchedule()
        mode = 'automatic'
        crashPoint = hashed
      } else if (!due) {
        mode = 'automatic'
        crashPoint = hashed
      } else {
        const index = this.schedule.cursor
        const entry = this.schedule.entries[index]
        this.schedule.cursor += 1
        if (this.schedule.dueIndex === index) this.schedule.dueIndex = null
        scheduleIndex = index
        mode = 'manual'
        crashPoint = entry.crash
        takeoffMs = SCHEDULE_TAKEOFF_MS
        flyAwayMs = scheduleFlyAwayMs(entry.crash, this.schedule.capMs)
        winnerIds = [...entry.winnerIds]
        if (entry.atMs != null) {
          const planned = nairobiClock(entry.atMs)
          const launched = nairobiClock(this.now())
          const delayed = this.now() > entry.atMs + ON_TIME_MS
          launchNote = ` · planned ${planned} · launched ${launched}${delayed ? ' · delayed' : ''}`
        }
      }
    } else if (this.schedule.status === 'paused') {
      mode = 'automatic'
      crashPoint = hashed
    } else if (mode === 'manual') {
      crashPoint = this.plan.crash ?? 2
      takeoffMs = this.plan.takeoffMs
      flyAwayMs = this.plan.flyAwayMs
      winnerIds = [...this.plan.winnerIds]
    }

    const now = this.now()
    this.round = {
      roundNo: nonce + 1,
      nonce,
      phase: 'betting',
      mode,
      serverSeed,
      serverSeedHash: sha256(serverSeed),
      crashPoint,
      takeoffMs,
      flyAwayMs,
      winnerIds,
      scheduleIndex,
      scheduleTotal,
      bettingEndsAt: now + takeoffMs,
      flightStartedAt: null,
      crashedAt: null,
      bets: [],
    }
    const label = scheduleIndex == null
      ? mode
      : `schedule ${scheduleIndex + 1}/${scheduleTotal} · ${crashPoint.toFixed(2)}x${launchNote}`
    this.pushLog('round', `Round ${this.round.roundNo} opened · ${label} · hash ${this.round.serverSeedHash}`)
    this.armBots()
  }

  private armBots() {
    if (!this.botsOn) return
    const amounts = [200, 500, 1000, 1500, 2000]
    for (const player of this.players.values()) {
      if (!player.bot) continue
      const marked = this.round.winnerIds.includes(player.id)
      if (!marked && this.random() > 0.72) continue
      const stake = marked ? 1000 : amounts[Math.floor(this.random() * amounts.length)] ?? 500
      if (player.balance < stake) continue
      let auto: number | null = null
      if (!marked && this.random() < 0.6) {
        auto = cents(1.15 + this.random() * 3) / 100
      }
      try {
        this.placeBet(player.id, stake, auto, 1)
      } catch {
        // A bot that cannot bet this round is skipped.
      }
    }
  }

  private multiplierNow(now: number): number {
    const round = this.round
    const started = round.flightStartedAt ?? now
    const elapsed = Math.max(0, now - started)
    let m: number
    if (round.flyAwayMs > 0) {
      const u = Math.min(1, elapsed / round.flyAwayMs)
      m = multiplierAt(secondsFor(round.crashPoint) * u)
    } else {
      m = multiplierAt(elapsed / 1000)
    }
    if (m > round.crashPoint) m = round.crashPoint
    return m
  }

  private shouldCrash(now: number, m: number): boolean {
    const round = this.round
    if (round.flyAwayMs > 0) return now - (round.flightStartedAt ?? now) >= round.flyAwayMs
    return m >= round.crashPoint
  }

  private publicMultiplier(now: number): number {
    if (this.round.phase === 'flying') return this.multiplierNow(now)
    if (this.round.phase === 'crashed') return this.round.crashPoint
    return 1
  }

  private cash(bet: Bet, at: number) {
    if (bet.status !== 'active') return
    const mult = cents(at) / 100
    if (cents(mult) >= cents(this.round.crashPoint) || cents(mult) < 101) return
    bet.status = 'cashed'
    bet.cashoutAt = mult
    bet.payout = payoutOf(bet.stake, mult)
    const player = this.players.get(bet.playerId)
    if (player) player.balance += bet.payout
    this.pushLog('cashout', `${bet.name} cashed out at ${mult.toFixed(2)}x · payout ${bet.payout}`)
  }

  private lose(bet: Bet) {
    if (bet.status !== 'active') return
    bet.status = 'lost'
    bet.payout = 0
    this.pushLog('bet', `${bet.name} lost ${bet.stake}`)
  }

  private publicBet(bet: Bet) {
    const player = this.players.get(bet.playerId)
    return {
      id: bet.id,
      playerId: bet.playerId,
      name: bet.name,
      panel: bet.panel,
      stake: bet.stake,
      auto: bet.auto,
      status: bet.status,
      cashoutAt: bet.cashoutAt,
      payout: bet.payout,
      color: avatarColor(bet.playerId),
      initials: initials(player?.name ?? bet.name),
    }
  }

  private playerByToken(token: string | undefined): Player {
    if (!token) throw httpError(401, 'demo_login_required')
    const player = this.players.get(this.tokens.get(token) ?? '')
    if (!player) throw httpError(401, 'demo_login_required')
    return player
  }

  private pushLog(kind: LogLine['kind'], text: string) {
    this.log.unshift({ id: this.logSeq++, at: this.now(), kind, text })
    if (this.log.length > 400) this.log.length = 400
  }

  private finishSchedule() {
    this.schedule.status = 'idle'
    this.schedule.finished = true
    this.overrideOnce = false
    this.plan = {
      mode: 'automatic',
      crash: null,
      takeoffMs: DEFAULT_TAKEOFF_MS,
      flyAwayMs: 0,
      winnerIds: [],
    }
    this.pushLog('round', 'Odds schedule finished')
    this.pushLog('round', 'Next round returned to automatic')
  }

  private scheduleView() {
    const now = this.now()
    const total = this.schedule.entries.length
    const active = this.round.scheduleIndex
    const cursor = this.schedule.cursor
    const nextEntry = this.schedule.entries[cursor]
    const countdown = this.countdownText(now, nextEntry)
    let progress = 'Schedule idle'
    if (this.schedule.finished) progress = 'Schedule finished · automatic'
    else if (this.schedule.status === 'running' && active != null && this.round.phase !== 'crashed') {
      progress = `Schedule round ${active + 1} of ${total}`
    } else if (this.schedule.status === 'running' && cursor < total) {
      progress = `Schedule round ${cursor + 1} of ${total} next`
    } else if (this.schedule.status === 'paused') {
      progress = `Schedule paused · next ${Math.min(cursor + 1, Math.max(total, 1))} of ${total}`
    }
    return {
      status: this.schedule.status,
      mode: this.schedule.mode,
      finished: this.schedule.finished,
      countdown,
      capSec: this.schedule.capMs / 1000,
      cursor,
      total,
      progress,
      entries: this.schedule.entries.map((entry, index) => ({
        crash: entry.crash,
        at: entry.atMs == null ? null : nairobiClock(entry.atMs),
        winnerIds: entry.winnerIds,
        winnerNames: entry.winnerIds.map((id) => this.players.get(id)?.name ?? id),
        state: this.entryState(index),
      })),
    }
  }

  private markTimedDue() {
    if (this.schedule.status !== 'running' || this.schedule.mode !== 'timed') return
    const entry = this.schedule.entries[this.schedule.cursor]
    if (entry?.atMs != null && this.now() >= entry.atMs) this.schedule.dueIndex = this.schedule.cursor
  }

  private timedDueNow(): boolean {
    if (this.schedule.status !== 'running' || this.schedule.mode !== 'timed' || this.overrideOnce) return false
    return this.schedule.dueIndex === this.schedule.cursor && this.schedule.cursor < this.schedule.entries.length
  }

  /** Don't start an automatic round that would still be flying when the next odd is due. */
  private idleForNextTimed(now: number): boolean {
    if (this.schedule.status !== 'running' || this.schedule.mode !== 'timed' || this.overrideOnce) return false
    const entry = this.schedule.entries[this.schedule.cursor]
    if (entry?.atMs == null) return false
    const wait = entry.atMs - now
    return wait > 0 && wait <= IMMINENT_MS
  }

  private countdownText(now: number, entry: ScheduleEntry | undefined): string {
    if (this.schedule.status !== 'running' || this.schedule.mode !== 'timed' || entry?.atMs == null) return ''
    const clock = nairobiClock(entry.atMs)
    const wait = entry.atMs - now
    if (wait > 0) return `Next ${entry.crash.toFixed(2)}x at ${clock} in ${formatSpan(wait)}`
    return `Next ${entry.crash.toFixed(2)}x at ${clock} · waiting for this round`
  }

  private entryState(index: number): 'done' | 'current' | 'next' | 'upcoming' {
    if (this.schedule.finished) return 'done'
    if (this.schedule.status === 'idle') return 'upcoming'
    const active = this.round.scheduleIndex
    if (active != null && index === active && this.round.phase !== 'crashed') return 'current'
    if (index < this.schedule.cursor) return 'done'
    if (index === this.schedule.cursor) return 'next'
    return 'upcoming'
  }
}
