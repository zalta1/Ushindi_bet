import { createHash, randomBytes } from 'node:crypto'

export const PENALTY_CLIENT_SEED = 'ushindi'

/** PesaBetPro default zones. Higher multiplier, lower win chance, about 90% RTP. */
export const PENALTY_ZONES: { zoneKey: string; label: string; multiplier: number; winChance: number; displayOrder: number }[] = [
  { zoneKey: 'top-left', label: 'Juu Kushoto', multiplier: 5, winChance: 0.18, displayOrder: 1 },
  { zoneKey: 'top-center', label: 'Juu Katikati', multiplier: 10, winChance: 0.09, displayOrder: 2 },
  { zoneKey: 'top-right', label: 'Juu Kulia', multiplier: 5, winChance: 0.18, displayOrder: 3 },
  { zoneKey: 'mid-left', label: 'Kati Kushoto', multiplier: 10, winChance: 0.09, displayOrder: 4 },
  { zoneKey: 'mid-center', label: 'Katikati', multiplier: 20, winChance: 0.045, displayOrder: 5 },
  { zoneKey: 'mid-right', label: 'Kati Kulia', multiplier: 10, winChance: 0.09, displayOrder: 6 },
  { zoneKey: 'bottom-left', label: 'Chini Kushoto', multiplier: 5, winChance: 0.18, displayOrder: 7 },
  { zoneKey: 'bottom-center', label: 'Chini Katikati', multiplier: 35, winChance: 0.026, displayOrder: 8 },
  { zoneKey: 'bottom-right', label: 'Chini Kulia', multiplier: 5, winChance: 0.18, displayOrder: 9 },
]

export const PENALTY_CHIPS = [500, 1000, 2000, 5000, 10000]
export const PENALTY_STAKE_STEP = 500

export type PenaltyOutcome = 'goal' | 'saved' | 'miss'

const HASH_SCALE = 4503599627370496

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** SHA-256(serverSeed + clientSeed + decimal nonce), the same mix the other games use. */
export function penaltyHash(serverSeed: string, clientSeed: string, nonce: number): string {
  return sha256(`${serverSeed}${clientSeed}${String(nonce)}`)
}

/** First 52 bits of a hex hash, as a unit interval. */
export function rollFromHash(hash: string, offset = 0): number {
  const slice = hash.slice(offset, offset + 13)
  if (slice.length < 13) return 0
  return Number.parseInt(slice, 16) / HASH_SCALE
}

let units: (() => number) | null = null

/** Tests pin the roll, the save/miss split, and the keeper pick. Production uses the hash. */
export function setPenaltyUnitsForTests(next: (() => number) | null) {
  units = next
}

export function nextUnit(hash: string, offset: number): number {
  return units ? units() : rollFromHash(hash, offset)
}

/**
 * A goal is `roll < winChance`, which is the chance stored on the zone.
 * A save and a miss both pay nothing. The published edge function is not in
 * the PesaBetPro source, so the non-paying shots are split in half: the lower
 * half is a save (the keeper is on the target) and the upper half is a miss.
 * When the Penalty budget switch is on, a draw under the loss rate forces that
 * non-paying result before the zone chance is consulted, the same way Dice
 * forces a loss while its budget is on.
 */
export function outcomeFromRolls(
  winChance: number,
  roll: number,
  split: number,
  force?: { rate: number; draw: number },
): PenaltyOutcome {
  const missed: PenaltyOutcome = split < 0.5 ? 'saved' : 'miss'
  if (force && force.draw < force.rate) return missed
  if (roll < winChance) return 'goal'
  return missed
}

export function keeperFor(target: string, outcome: PenaltyOutcome, pick: number): string {
  if (outcome === 'saved') return target
  const others = PENALTY_ZONES.map((zone) => zone.zoneKey).filter((key) => key !== target)
  const index = Math.min(others.length - 1, Math.max(0, Math.floor(pick * others.length)))
  return others[index] ?? target
}

export function penaltyPayout(stake: number, multiplier: number, maxPayout: number): number {
  const raw = Math.floor((stake * Math.round(multiplier * 100)) / 100)
  return Math.max(0, Math.min(raw, maxPayout))
}

export function newServerSeed(): string {
  return randomBytes(32).toString('hex')
}
