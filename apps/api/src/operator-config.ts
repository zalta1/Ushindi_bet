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

/**
 * Live operator limits. Env values are the first-boot defaults.
 * `loadPersistedSettings` replaces them from the settings table, and admin
 * saves write that table, so a restart keeps the saved minimum deposit.
 */
export const operatorConfig = {
  marginBps: 600,
  minStake: 500,
  maxStake: 500000,
  minWithdraw: 1000,
  maxWithdraw: 5000000,
  minDeposit,
  maxDeposit,
  rtpBps: 9700,
  withdrawalsEnabled: true,
  cashoutEnabled: false,
  cashoutMarginBps: 1200,
  payoutPercentBps: 8800,
  feedSyncEnabled: false,
  lifecycleEnabled: false,
  hotMatchesAuto: false,
  feedSyncIntervalSec: 300,
  liveOddsIntervalSec: 60,
  lifecycleIntervalSec: 30,
  welcomeBonusEnabled: false,
  welcomeBonusTzs: 0,
  securityDepositTzs: 0,
  securityUnlockTzs: 0,
  agentWhatsapp: '',
  maintenanceMode: false,
  currency: 'TZS' as const,
}

export const INT_SETTING_KEYS = [
  'marginBps',
  'minStake',
  'maxStake',
  'minWithdraw',
  'maxWithdraw',
  'minDeposit',
  'maxDeposit',
  'rtpBps',
  'welcomeBonusTzs',
  'securityDepositTzs',
  'securityUnlockTzs',
  'cashoutMarginBps',
  'payoutPercentBps',
  'feedSyncIntervalSec',
  'liveOddsIntervalSec',
  'lifecycleIntervalSec',
] as const

export const BOOL_SETTING_KEYS = [
  'withdrawalsEnabled',
  'cashoutEnabled',
  'feedSyncEnabled',
  'lifecycleEnabled',
  'hotMatchesAuto',
  'welcomeBonusEnabled',
  'maintenanceMode',
] as const

export type IntSettingKey = (typeof INT_SETTING_KEYS)[number]
export type BoolSettingKey = (typeof BOOL_SETTING_KEYS)[number]

export function applyMargin(fair: number) {
  return Math.max(1.01, +(1 + (fair - 1) * (1 - operatorConfig.marginBps / 10000)).toFixed(2))
}
