import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertZungushaRanges(next: {
  zungushaSpinCost: number
  zungushaMinStake: number
  zungushaMaxStake: number
  zungushaMaxPayout: number
}) {
  if (next.zungushaMinStake < 100 || next.zungushaMinStake > next.zungushaMaxStake) {
    throw new ApiError(400, 'validation', { fields: { zungushaMinStake: 'range' } })
  }
  if (next.zungushaMaxStake > 2_000_000) {
    throw new ApiError(400, 'validation', { fields: { zungushaMaxStake: 'range' } })
  }
  if (next.zungushaSpinCost < next.zungushaMinStake || next.zungushaSpinCost > next.zungushaMaxStake) {
    throw new ApiError(400, 'validation', { fields: { zungushaSpinCost: 'range' } })
  }
  if (next.zungushaMaxPayout < 1 || next.zungushaMaxPayout > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { zungushaMaxPayout: 'range' } })
  }
}

export function zungushaSettings() {
  return {
    zungushaEnabled: operatorConfig.zungushaEnabled,
    zungushaSpinCost: operatorConfig.zungushaSpinCost,
    zungushaMinStake: operatorConfig.zungushaMinStake,
    zungushaMaxStake: operatorConfig.zungushaMaxStake,
    zungushaMaxPayout: operatorConfig.zungushaMaxPayout,
  }
}
