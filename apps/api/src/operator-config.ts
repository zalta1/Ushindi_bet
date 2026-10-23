function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
  return n
}

const minDeposit = positiveInt('MIN_DEPOSIT_TZS', 30_000)
const maxDeposit = positiveInt('MAX_DEPOSIT_TZS', 5_000_000)
if (minDeposit > maxDeposit) throw new Error('MIN_DEPOSIT_TZS cannot exceed MAX_DEPOSIT_TZS')

export const operatorConfig = {
  marginBps: 600,
  minStake: 500,
  maxStake: 500000,
  minWithdraw: 1000,
  maxWithdraw: 5000000,
  minDeposit,
  maxDeposit,
  rtpBps: 9700,
}

export function applyMargin(fair: number) {
  return Math.max(1.01, +(1 + (fair - 1) * (1 - operatorConfig.marginBps / 10000)).toFixed(2))
}
