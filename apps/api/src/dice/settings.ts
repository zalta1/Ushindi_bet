import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertDiceRanges(next: {
  diceRtpBps: number
  diceMinStake: number
  diceMaxStake: number
  diceMaxWin: number
}) {
  if (next.diceRtpBps < 9000 || next.diceRtpBps > 9900) {
    throw new ApiError(400, 'validation', { fields: { diceRtpBps: 'range' } })
  }
  if (next.diceMinStake < 100 || next.diceMinStake > next.diceMaxStake) {
    throw new ApiError(400, 'validation', { fields: { diceMinStake: 'range' } })
  }
  if (next.diceMaxStake > 2_000_000) {
    throw new ApiError(400, 'validation', { fields: { diceMaxStake: 'range' } })
  }
  if (next.diceMaxWin < next.diceMaxStake || next.diceMaxWin > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { diceMaxWin: 'range' } })
  }
}

export function diceSettings() {
  return {
    diceEnabled: operatorConfig.diceEnabled,
    diceRtpBps: operatorConfig.diceRtpBps,
    diceMinStake: operatorConfig.diceMinStake,
    diceMaxStake: operatorConfig.diceMaxStake,
    diceMaxWin: operatorConfig.diceMaxWin,
  }
}
