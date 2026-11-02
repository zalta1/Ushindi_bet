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

/** Natural flight, shortened to the cap when the curve would run longer. */
export function flightMs(crash: number, capMs: number): number {
  const natural = Math.max(0, Math.round(secondsFor(Math.max(1, crash)) * 1000))
  if (natural <= capMs) return natural
  return Math.round(capMs)
}

export function scheduleFlyAwayMs(crash: number, capMs: number): number {
  const natural = secondsFor(Math.max(1, crash)) * 1000
  if (natural <= capMs) return 0
  return Math.round(capMs)
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
