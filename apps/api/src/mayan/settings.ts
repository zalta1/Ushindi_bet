import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertMayanRanges(next: {
  mayanMinStake: number
  mayanMaxStake: number
  mayanMaxWin: number
}) {
  if (next.mayanMinStake < 50 || next.mayanMinStake > next.mayanMaxStake) {
    throw new ApiError(400, 'validation', { fields: { mayanMinStake: 'range' } })
  }
  if (next.mayanMaxStake > 2_000_000) {
    throw new ApiError(400, 'validation', { fields: { mayanMaxStake: 'range' } })
  }
  if (next.mayanMaxWin < next.mayanMaxStake || next.mayanMaxWin > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { mayanMaxWin: 'range' } })
  }
}

export function mayanSettings() {
  return {
    mayanEnabled: operatorConfig.mayanEnabled,
    mayanMinStake: operatorConfig.mayanMinStake,
    mayanMaxStake: operatorConfig.mayanMaxStake,
    mayanMaxWin: operatorConfig.mayanMaxWin,
  }
}
