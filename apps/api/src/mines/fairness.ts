import { randomBytes } from 'node:crypto'

export const MINES_CELLS = 25
export const MINES_MAX_COUNT = 24

/** PesaBetPro `rnd` / `rndInt`: a uint32 divided by 2^32, then scaled. */
export function cryptoUnit(): number {
  return randomBytes(4).readUInt32BE(0) / 4294967296
}

let rndIntImpl = (maxExclusive: number) => Math.floor(cryptoUnit() * maxExclusive)

/** Tests pin mine positions. Production keeps the crypto draw. */
export function setMinesRndForTests(next: ((maxExclusive: number) => number) | null) {
  rndIntImpl = next ?? ((maxExclusive: number) => Math.floor(cryptoUnit() * maxExclusive))
}

/**
 * PesaBetPro `minesMultiplier`. Each safe reveal multiplies by the remaining
 * cells over the remaining safe cells, then by RTP. 9700 basis points is 0.97.
 */
export function minesMultiplier(safeRevealed: number, mineCount: number, rtpBps: number): number {
  if (safeRevealed <= 0) return 1
  const safeCells = MINES_CELLS - mineCount
  let mult = 1
  for (let i = 0; i < safeRevealed; i++) {
    mult *= (MINES_CELLS - i) / (safeCells - i)
  }
  return Math.max(1, Number((mult * (rtpBps / 10000)).toFixed(2)))
}

/** PesaBetPro `generateMines`: uniform positions, no loss-rate argument. */
export function generateMines(mineCount: number, rndInt: (maxExclusive: number) => number = rndIntImpl): number[] {
  const mines = new Set<number>()
  while (mines.size < mineCount) mines.add(rndInt(MINES_CELLS))
  return [...mines]
}

export function minesPayout(stake: number, multiplier: number, maxWin: number): number {
  const raw = Math.floor((stake * Math.round(multiplier * 100)) / 100)
  return Math.max(0, Math.min(raw, maxWin))
}
