import { randomBytes } from 'node:crypto'

/** PesaBetPro `gg` / `WHEEL_SEGMENTS`. The pointer sits on segment 0 at the top when rotation is 0. */
export const WHEEL_SEGMENTS: { multiplier: number; color: string; label: string }[] = [
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4.8, color: '#1E90FF', label: 'x4.8' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 12, color: '#E85D04', label: 'x12' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4.8, color: '#1E90FF', label: 'x4.8' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 24, color: '#DC143C', label: 'x24' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 4.8, color: '#1E90FF', label: 'x4.8' },
  { multiplier: 48, color: '#FF1493', label: 'x48' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 12, color: '#E85D04', label: 'x12' },
  { multiplier: 1000, color: '#00C853', label: 'x1000' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
  { multiplier: 4.8, color: '#1E90FF', label: 'x4.8' },
  { multiplier: 4, color: '#D4A017', label: 'x4' },
  { multiplier: 100, color: '#00BFA5', label: 'x100' },
  { multiplier: 2.5, color: '#7B2D8E', label: 'x2.5' },
]

/** PesaBetPro `Kw`. A bet is on a multiplier, and any segment with that multiplier pays. */
export const MAYAN_TARGETS: { id: string; multiplier: number; color: string; emoji: string; label: string }[] = [
  { id: 'x4', multiplier: 4, color: '#D4A017', emoji: '🗿', label: 'x4' },
  { id: 'x12', multiplier: 12, color: '#E85D04', emoji: '🗿', label: 'x12' },
  { id: 'x48', multiplier: 48, color: '#FF1493', emoji: '🗿', label: 'x48' },
  { id: 'x1000', multiplier: 1000, color: '#00C853', emoji: '🏛️', label: 'UP TO x1000' },
  { id: 'x2.5', multiplier: 2.5, color: '#7B2D8E', emoji: '🗿', label: 'x2.5' },
  { id: 'x4.8', multiplier: 4.8, color: '#1E90FF', emoji: '🗿', label: 'x4.8' },
  { id: 'x24', multiplier: 24, color: '#DC143C', emoji: '🗿', label: 'x24' },
  { id: 'x100', multiplier: 100, color: '#00BFA5', emoji: '🏛️', label: 'UP TO x100' },
]

/** PesaBetPro chip row `j`. */
export const MAYAN_CHIPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000]

const TARGET_BY_ID = new Map(MAYAN_TARGETS.map((target) => [target.id, target]))

/** Integer tenths. 2.5 × 100 = 250 and 4.8 × 100 = 480, without a binary float. */
const TENTHS: Record<string, number> = {
  '2.5': 25,
  '4': 40,
  '4.8': 48,
  '12': 120,
  '24': 240,
  '48': 480,
  '100': 1000,
  '1000': 10000,
}

/** PesaBetPro `rnd`: a uint32 divided by 2^32. */
export function cryptoUnit(): number {
  return randomBytes(4).readUInt32BE(0) / 4294967296
}

let unit: () => number = cryptoUnit

/** Tests pin the wheel. Production keeps the crypto unit interval. */
export function setMayanUnitForTests(next: (() => number) | null) {
  unit = next ?? cryptoUnit
}

/** PesaBetPro `weightFor`. High multipliers are rare on both the win and the loss draw. */
export function weightFor(multiplier: number, win: boolean): number {
  if (multiplier >= 100) return 1
  if (multiplier >= 24) return win ? 2 : 3
  if (multiplier >= 12) return win ? 4 : 5
  return win ? 10 : 15
}

/**
 * PesaBetPro `generateWheelIndex`.
 * When `rnd()` is under the loss rate and the player left a multiplier uncovered,
 * the stop is drawn from the uncovered segments. Otherwise it is drawn from the
 * covered ones. There is no seed and no fair path.
 */
export function generateWheelIndex(bettedMultipliers: number[], lossRate: number, rnd: () => number = unit): number {
  const betted = new Set(bettedMultipliers)
  const idxs = WHEEL_SEGMENTS.map((segment, index) => ({ m: segment.multiplier, i: index }))
  const unbetted = idxs.filter((segment) => !betted.has(segment.m))
  const inBets = idxs.filter((segment) => betted.has(segment.m))

  const pick = (pool: { m: number; i: number }[], win: boolean) => {
    const weights = pool.map((segment) => weightFor(segment.m, win))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let r = rnd() * total
    for (let k = 0; k < weights.length; k++) {
      r -= weights[k]
      if (r <= 0) return pool[k].i
    }
    return pool[pool.length - 1].i
  }

  if (rnd() < lossRate && unbetted.length > 0) return pick(unbetted, false)
  if (inBets.length > 0) return pick(inBets, true)
  return Math.floor(rnd() * WHEEL_SEGMENTS.length)
}

export function mayanTarget(id: string) {
  return TARGET_BY_ID.get(id) ?? null
}

/**
 * Payout for the landed segment.
 * The published edge function is not in the PesaBetPro source. The live client
 * treats a spin as a win only when the player staked the landed multiplier
 * (`x${multiplier}`) and the server winnings are above zero. That stake times
 * the multiplier is the payout. Stakes on the other seven targets are lost.
 * There is no RTP factor on this wheel.
 */
export function mayanPayout(stakeOnLanded: number, multiplier: number, maxWin: number): number {
  if (stakeOnLanded <= 0) return 0
  const tenths = TENTHS[String(multiplier)]
  if (!tenths) return 0
  const raw = Math.floor((stakeOnLanded * tenths) / 10)
  return Math.max(0, Math.min(raw, maxWin))
}
