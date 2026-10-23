export const operatorConfig = {
  marginBps: 600,
  minStake: 500,
  maxStake: 500000,
  minWithdraw: 1000,
  maxWithdraw: 5000000,
  rtpBps: 9700,
}

export function applyMargin(fair: number) {
  return Math.max(1.01, +(1 + (fair - 1) * (1 - operatorConfig.marginBps / 10000)).toFixed(2))
}
