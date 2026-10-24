import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertPenaltyRanges(next: {
  penaltyMinStake: number
  penaltyMaxStake: number
  penaltyMaxPayout: number
}) {
  if (next.penaltyMinStake < 100 || next.penaltyMinStake > next.penaltyMaxStake) {
    throw new ApiError(400, 'validation', { fields: { penaltyMinStake: 'range' } })
  }
  if (next.penaltyMaxStake > 2_000_000) {
    throw new ApiError(400, 'validation', { fields: { penaltyMaxStake: 'range' } })
  }
  if (next.penaltyMaxPayout < next.penaltyMaxStake || next.penaltyMaxPayout > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { penaltyMaxPayout: 'range' } })
  }
}

export function penaltySettings() {
  return {
    penaltyEnabled: operatorConfig.penaltyEnabled,
    penaltyMinStake: operatorConfig.penaltyMinStake,
    penaltyMaxStake: operatorConfig.penaltyMaxStake,
    penaltyMaxPayout: operatorConfig.penaltyMaxPayout,
  }
}
