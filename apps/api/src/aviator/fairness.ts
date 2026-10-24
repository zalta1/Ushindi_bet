import { createHash } from 'node:crypto'

/** Public client seed mixed into every round. PesaBetPro's engine hashed only serverSeed+nonce. */
export const AVIATOR_CLIENT_SEED = 'ushindi'

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
 * Bustabit-style crash point from the PesaBetPro game engine.
 * rtpPct is a percent (96), not a fraction. Instant crash when the first
 * 52 hash bits are divisible by floor(1 / houseEdge). At RTP 96 that
 * modulo is 24, not the comment's 25, because 1 / (1 - 0.96) is
 * 24.99999999999998 in IEEE-754. This matches the PesaBetPro engine.
 * Otherwise
 * floor(100 * 2^52 / (2^52 - h)) / 100, capped at maxMultiplier.
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

/** Same growth curve as aviator_multiplier() in Postgres, floored to 2 decimals. */
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

export function maskPhone(phone: string): string {
  const local = phone.startsWith('+255') ? `0${phone.slice(4)}` : phone
  return `07**${local.slice(-3)}`
}

export function avatarColor(userId: string): string {
  const colors = ['#e85d4c', '#f5c518', '#3d8bfd', '#19c37d', '#c084fc', '#fb7185', '#22d3ee', '#f97316']
  let n = 0
  for (const ch of userId) n = (n * 33 + ch.charCodeAt(0)) >>> 0
  return colors[n % colors.length]
}

export function initials(phone: string): string {
  const local = phone.startsWith('+255') ? `0${phone.slice(4)}` : phone
  return local.slice(-2)
}
