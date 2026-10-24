import { createHash } from 'node:crypto'

export const DICE_CLIENT_SEED = 'ushindi'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** SHA-256(serverSeed + clientSeed + decimal nonce), the same mix Aviator uses. */
export function diceHash(serverSeed: string, clientSeed: string, nonce: number): string {
  return sha256(`${serverSeed}${clientSeed}${String(nonce)}`)
}

/** Uniform roll from 1 to 100. The first 52 hash bits modulo 100, plus one. */
export function rollFromHash(hash: string): number {
  const h = Number.parseInt(hash.slice(0, 13), 16)
  if (!Number.isFinite(h)) return 1
  return (h % 100) + 1
}

/**
 * PesaBetPro's dice price: (99 / winning window) × RTP.
 * Under wins on rolls 1..target. Over wins on rolls target+1..100.
 * RTP is basis points, so 9700 reproduces the original 0.97 factor.
 */
export function diceMultiplier(target: number, side: 'under' | 'over', rtpBps: number): number {
  const window = side === 'under' ? target : 100 - target
  if (window <= 0) return 0
  return Number(((99 / window) * (rtpBps / 10000)).toFixed(2))
}

export function diceWins(roll: number, target: number, side: 'under' | 'over'): boolean {
  return side === 'under' ? roll <= target : roll > target
}

export function dicePayout(stake: number, multiplier: number, maxWin: number): number {
  const raw = Math.floor((stake * Math.round(multiplier * 100)) / 100)
  return Math.max(0, Math.min(raw, maxWin))
}
