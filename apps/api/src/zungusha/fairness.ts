import { createHash, randomBytes } from 'node:crypto'

export const ZUNGUSHA_CLIENT_SEED = 'ushindi'
export const ZUNGUSHA_CHIPS = [100, 500, 1000, 5000]

/**
 * The live `zungusha_rewards` rows are not in the published client. These
 * match the columns their admin edits. Weights are the odds (weight / sum).
 * Segment counts only repeat slices on the wheel. At a 500 TSh spin the
 * fixed prizes return 450, about 90 percent.
 */
export const ZUNGUSHA_REWARDS: {
  rewardKey: string
  label: string
  amountTzs: number
  segmentCount: number
  weight: number
  color: string
  isLost: boolean
  displayOrder: number
}[] = [
  { rewardKey: 'lost', label: 'LOST', amountTzs: 0, segmentCount: 6, weight: 3572, color: '#4b5563', isLost: true, displayOrder: 1 },
  { rewardKey: 'tsh-200', label: '200', amountTzs: 200, segmentCount: 3, weight: 2000, color: '#22c55e', isLost: false, displayOrder: 2 },
  { rewardKey: 'tsh-500', label: '500', amountTzs: 500, segmentCount: 2, weight: 4200, color: '#3b82f6', isLost: false, displayOrder: 3 },
  { rewardKey: 'tsh-1000', label: '1000', amountTzs: 1000, segmentCount: 2, weight: 200, color: '#a855f7', isLost: false, displayOrder: 4 },
  { rewardKey: 'tsh-5000', label: '5000', amountTzs: 5000, segmentCount: 1, weight: 20, color: '#f59e0b', isLost: false, displayOrder: 5 },
  { rewardKey: 'tsh-20000', label: '20000', amountTzs: 20000, segmentCount: 1, weight: 5, color: '#ef4444', isLost: false, displayOrder: 6 },
  { rewardKey: 'tsh-50000', label: '50000', amountTzs: 50000, segmentCount: 1, weight: 2, color: '#ec4899', isLost: false, displayOrder: 7 },
  { rewardKey: 'iphone', label: 'iPhone 17 Pro Max', amountTzs: 1_500_000, segmentCount: 1, weight: 1, color: '#eab308', isLost: false, displayOrder: 8 },
]

export type WheelReward = {
  id: string
  weight: number
  segmentCount: number
  isLost: boolean
}

const HASH_SCALE = 4503599627370496

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function zungushaHash(serverSeed: string, clientSeed: string, nonce: number): string {
  return sha256(`${serverSeed}${clientSeed}${String(nonce)}`)
}

export function rollFromHash(hash: string, offset = 0): number {
  const slice = hash.slice(offset, offset + 13)
  if (slice.length < 13) return 0
  return Number.parseInt(slice, 16) / HASH_SCALE
}

let units: (() => number) | null = null

export function setZungushaUnitsForTests(next: (() => number) | null) {
  units = next
}

export function nextUnit(hash: string, offset: number): number {
  return units ? units() : rollFromHash(hash, offset)
}

export function newServerSeed(): string {
  return randomBytes(32).toString('hex')
}

function scaledWeights(rewards: WheelReward[]): { reward: WheelReward; scaled: number }[] {
  return rewards
    .filter((reward) => reward.weight > 0 && reward.segmentCount > 0)
    .map((reward) => ({ reward, scaled: Math.floor(reward.weight * 1_000_000) }))
    .filter((row) => row.scaled > 0)
}

/** Walk the weights. A zero weight is skipped. The unit is clamped to [0, 1). */
export function pickByWeight(rewards: WheelReward[], unit: number): WheelReward {
  const pool = scaledWeights(rewards)
  const total = pool.reduce((sum, row) => sum + row.scaled, 0)
  if (total <= 0) throw new Error('no_weight')
  const clamped = Math.min(0.999999999999, Math.max(0, unit))
  let mark = Math.floor(clamped * total)
  if (mark >= total) mark = total - 1
  for (const row of pool) {
    if (mark < row.scaled) return row.reward
    mark -= row.scaled
  }
  return pool[pool.length - 1].reward
}

/**
 * While the budget switch is on, a draw under the loss rate picks an active
 * LOST prize by its weight. Otherwise the draw uses every active weight.
 * If no LOST prize has weight, the spin falls through to the normal weights.
 */
export function chooseReward(
  rewards: WheelReward[],
  weightUnit: number,
  force?: { rate: number; draw: number },
): { reward: WheelReward; forced: boolean } {
  if (force && force.draw < force.rate) {
    const lost = rewards.filter((reward) => reward.isLost)
    if (scaledWeights(lost).length > 0) return { reward: pickByWeight(lost, weightUnit), forced: true }
  }
  return { reward: pickByWeight(rewards, weightUnit), forced: false }
}

/** Index in the expanded active list, the same order the wheel paints. */
export function segmentIndexFor(
  rewards: { id: string; segmentCount: number }[],
  rewardId: string,
  unit: number,
): number {
  const slices: number[] = []
  let index = 0
  for (const reward of rewards) {
    const count = Math.max(0, reward.segmentCount)
    for (let i = 0; i < count; i += 1) {
      if (reward.id === rewardId) slices.push(index)
      index += 1
    }
  }
  if (!slices.length) return 0
  const clamped = Math.min(0.999999999999, Math.max(0, unit))
  const pick = Math.min(slices.length - 1, Math.floor(clamped * slices.length))
  return slices[pick] ?? 0
}

export function zungushaPayout(amountTzs: number, isLost: boolean, maxPayout: number): number {
  if (isLost) return 0
  return Math.max(0, Math.min(Math.floor(amountTzs), maxPayout))
}
