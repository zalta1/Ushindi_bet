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

  constructor(options: EngineOptions = {}) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.seed = options.seed ?? (() => randomBytes(32).toString('hex'))
    this.botsOn = options.bots !== false
    for (const bot of BOTS) this.players.set(bot.id, { ...bot, bot: true })
    this.openRound()
  }

  tick(): void {
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
        this.pushLog('round', `Round ${round.roundNo} flew away at ${round.crashPoint.toFixed(2)}x · ${round.mode} · nonce ${round.nonce} · seed ${round.serverSeed}`)
      }
      return
    }
    if (round.phase === 'crashed' && round.crashedAt != null && now >= round.crashedAt + DEFAULT_CRASHED_MS) {
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
    const names = unique.map((id) => this.players.get(id)?.name ?? id)
    this.pushLog('round', names.length ? `Next round winners · ${names.join(', ')}` : 'Next round winners cleared')
    return this.plan
  }

  /** The following round uses the hash. This round is left as it opened. */
  automatic(): Plan {
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
      },
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
    }
  }

  private openRound() {
    const nonce = this.nonce
    this.nonce += 1
    const serverSeed = this.seed()
    const mode = this.plan.mode
    const hashInput = crashHash(serverSeed, DEMO_CLIENT_SEED, nonce)
    let crashPoint = crashPointFromHash(hashInput, DEMO_RTP_PCT, DEMO_MAX_MULTIPLIER)
    let takeoffMs = DEFAULT_TAKEOFF_MS
    let flyAwayMs = 0
    let winnerIds: string[] = []
    if (mode === 'manual') {
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
      bettingEndsAt: now + takeoffMs,
      flightStartedAt: null,
      crashedAt: null,
      bets: [],
    }
    this.pushLog('round', `Round ${this.round.roundNo} opened · ${mode} · hash ${this.round.serverSeedHash}`)
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
    if (this.log.length > 80) this.log.length = 80
  }
}
