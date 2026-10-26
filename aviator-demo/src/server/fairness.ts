import { createHash } from 'node:crypto'

/** Client seed mixed into every automatic round. Local to this demo. */
export const DEMO_CLIENT_SEED = 'demo'
export const DEMO_RTP_PCT = 96
export const DEMO_MAX_MULTIPLIER = 1000

const SEGMENTS = [
  { maxM: 1.5, k: 0.07 },
  { maxM: 2, k: 0.07 },
  { maxM: 10, k: 0.08 },
  { maxM: Number.POSITIVE_INFINITY, k: 0.09 },
]

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Crash hash is SHA-256(serverSeed + clientSeed + decimal nonce), UTF-8, hex. */
export function crashHash(serverSeed: string, clientSeed: string, nonce: number): string {
  return sha256(`${serverSeed}${clientSeed}${String(nonce)}`)
}

/**
 * Bustabit-style crash point, copied so this demo does not import the real game.
 * rtpPct is a percent (96). Instant crash when the first 52 hash bits are
 * divisible by floor(1 / houseEdge). At RTP 96 that modulo is 24.
 * Otherwise floor(100 * 2^52 / (2^52 - h)) / 100, capped at maxMultiplier.
 */
export function crashPointFromHash(hash: string, rtpPct: number, maxMultiplier: number): number {
  const houseEdge = Math.max(0.005, Math.min(0.5, 1 - rtpPct / 100))
  const h = parseInt(hash.slice(0, 13), 16)
  if (!Number.isFinite(h)) return 1
  const mod = Math.floor(1 / houseEdge)
  if (mod > 0 && h % mod === 0) return 1
  const e = 2 ** 52
  const denom = e - h
  if (denom <= 0) return 1
  let crash = Math.floor((100 * e) / denom) / 100
  if (!Number.isFinite(crash) || crash < 1) crash = 1
  if (crash > maxMultiplier) crash = maxMultiplier
  return Number(crash.toFixed(2))
}

/** Growth curve floored to 2 decimals. Same segments as the real flight. */
export function multiplierAt(seconds: number): number {
  let m = 1
  let remaining = Math.max(0, seconds)
  if (remaining <= 0) return 1
  for (let i = 0; i < SEGMENTS.length; i += 1) {
    const segment = SEGMENTS[i]
    const dt = Math.log(segment.maxM / m) / segment.k
    if (remaining <= dt || i === SEGMENTS.length - 1) {
      m = m * Math.exp(segment.k * Math.min(remaining, dt))
      break
    }
    remaining -= dt
    m = segment.maxM
  }
  if (m < 1) m = 1
  return Math.floor(m * 100) / 100
}

/** Seconds of natural flight required to reach a multiplier. */
export function secondsFor(mult: number): number {
  const target = Math.max(1, mult)
  let t = 0
  let cur = 1
  for (const segment of SEGMENTS) {
    const cap = Math.min(target, segment.maxM)
    if (cap <= cur) break
    t += Math.log(cap / cur) / segment.k
    cur = cap
    if (target <= segment.maxM) break
  }
  return t
}

export function avatarColor(userId: string): string {
  const colors = ['#e85d4c', '#f5c518', '#3d8bfd', '#19c37d', '#c084fc', '#fb7185', '#22d3ee', '#f97316']
  let n = 0
  for (const ch of userId) n = (n * 33 + ch.charCodeAt(0)) >>> 0
  return colors[n % colors.length]
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const letters = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
  return letters.toUpperCase() || '??'
}

export function cents(mult: number): number {
  return Math.round(mult * 100)
}

/** Whole-unit payout. Fake credit only. */
export function payoutOf(stake: number, mult: number): number {
  return Math.round((stake * cents(mult)) / 100)
}
