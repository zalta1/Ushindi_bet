import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertAviatorRanges(next: {
  aviatorRtpBps: number
  aviatorMaxMultiplier: number
  aviatorMinStake: number
  aviatorMaxStake: number
  aviatorMaxWin: number
  aviatorBettingMs: number
  aviatorCrashedMs: number
}) {
  if (next.aviatorRtpBps < 8000 || next.aviatorRtpBps > 9900) {
    throw new ApiError(400, 'validation', { fields: { aviatorRtpBps: 'range' } })
  }
  if (next.aviatorMaxMultiplier < 50 || next.aviatorMaxMultiplier > 100_000) {
    throw new ApiError(400, 'validation', { fields: { aviatorMaxMultiplier: 'range' } })
  }
  if (next.aviatorMinStake < 1 || next.aviatorMinStake > next.aviatorMaxStake) {
    throw new ApiError(400, 'validation', { fields: { aviatorMinStake: 'range' } })
  }
  if (next.aviatorMaxWin < 1) {
    throw new ApiError(400, 'validation', { fields: { aviatorMaxWin: 'range' } })
  }
  if (next.aviatorBettingMs < 1000 || next.aviatorBettingMs > 60_000) {
    throw new ApiError(400, 'validation', { fields: { aviatorBettingMs: 'range' } })
  }
  if (next.aviatorCrashedMs < 1000 || next.aviatorCrashedMs > 60_000) {
    throw new ApiError(400, 'validation', { fields: { aviatorCrashedMs: 'range' } })
  }
}

export function aviatorSettings() {
  return {
    aviatorEnabled: operatorConfig.aviatorEnabled,
    aviatorRtpBps: operatorConfig.aviatorRtpBps,
    aviatorMaxMultiplier: operatorConfig.aviatorMaxMultiplier,
    aviatorMinStake: operatorConfig.aviatorMinStake,
    aviatorMaxStake: operatorConfig.aviatorMaxStake,
    aviatorMaxWin: operatorConfig.aviatorMaxWin,
    aviatorBettingMs: operatorConfig.aviatorBettingMs,
    aviatorCrashedMs: operatorConfig.aviatorCrashedMs,
  }
}
