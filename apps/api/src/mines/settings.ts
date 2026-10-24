import { ApiError } from '../errors.js'
import { operatorConfig } from '../operator-config.js'

export function assertMinesRanges(next: {
  minesRtpBps: number
  minesMinStake: number
  minesMaxStake: number
  minesMaxWin: number
}) {
  if (next.minesRtpBps < 9000 || next.minesRtpBps > 9900) {
    throw new ApiError(400, 'validation', { fields: { minesRtpBps: 'range' } })
  }
  if (next.minesMinStake < 100 || next.minesMinStake > next.minesMaxStake) {
    throw new ApiError(400, 'validation', { fields: { minesMinStake: 'range' } })
  }
  if (next.minesMaxStake > 2_000_000) {
    throw new ApiError(400, 'validation', { fields: { minesMaxStake: 'range' } })
  }
  if (next.minesMaxWin < next.minesMaxStake || next.minesMaxWin > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { minesMaxWin: 'range' } })
  }
}

export function minesSettings() {
  return {
    minesEnabled: operatorConfig.minesEnabled,
    minesRtpBps: operatorConfig.minesRtpBps,
    minesMinStake: operatorConfig.minesMinStake,
    minesMaxStake: operatorConfig.minesMaxStake,
    minesMaxWin: operatorConfig.minesMaxWin,
  }
}
