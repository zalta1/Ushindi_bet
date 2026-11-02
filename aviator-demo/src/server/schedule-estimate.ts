/** Shared flight timing for the demo schedule. Same curve as the round engine. */

export const SCHEDULE_TAKEOFF_MS = 1_500
export const SCHEDULE_GAP_MS = 1_000

const SEGMENTS = [
  { maxM: 1.5, k: 0.07 },
  { maxM: 2, k: 0.07 },
  { maxM: 10, k: 0.08 },
  { maxM: Number.POSITIVE_INFINITY, k: 0.09 },
]

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

/** Natural flight time. The cap never shortens this. */
export function flightMs(crash: number, _capMs = 0): number {
  return Math.max(0, Math.round(secondsFor(Math.max(1, crash)) * 1000))
}

/** Set odds always use the natural curve, so this stays 0. */
export function scheduleFlyAwayMs(_crash: number, _capMs: number): number {
  return 0
}

export function exceedsCap(crash: number, capMs: number): boolean {
  return secondsFor(Math.max(1, crash)) * 1000 > capMs
}

/** When each odd's betting window opens, starting from startMs. */
export function estimateStarts(startMs: number, crashes: number[], capMs: number): number[] {
  const starts: number[] = []
  let t = startMs
  for (const crash of crashes) {
    starts.push(t)
    t += SCHEDULE_TAKEOFF_MS + flightMs(crash, capMs) + SCHEDULE_GAP_MS
  }
  return starts
}
