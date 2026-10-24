import type { PoolClient } from 'pg'
import { money } from '../errors.js'

/**
 * PesaBetPro's default when the budget switch is off.
 * Dice uses this rate only while its switch is on.
 * Mayan always calls `lossRate()`, so a disabled budget still returns 0.80.
 * Penalty keeps the same budget row for the admin, and the kick still uses the zone win chance.
 */
export const DEFAULT_LOSS_RATE = 0.8
export const DEFAULT_BUDGET_TZS = 25_000

export type CasinoGame = 'dice' | 'mines' | 'mayan' | 'penalty'

export type BudgetRow = {
  budgetTzs: number
  totalBetsTzs: number
  totalPayoutsTzs: number
  enabled: boolean
}

const TABLES: Record<CasinoGame, string> = {
  dice: 'dice_budget',
  mines: 'mines_budget',
  mayan: 'mayan_budget',
  penalty: 'penalty_budget',
}

type SqlRow = {
  budget_tzs: string
  total_bets_tzs: string
  total_payouts_tzs: string
  enabled: boolean
}

function mapRow(row: SqlRow): BudgetRow {
  return {
    budgetTzs: money(row.budget_tzs),
    totalBetsTzs: money(row.total_bets_tzs),
    totalPayoutsTzs: money(row.total_payouts_tzs),
    enabled: row.enabled,
  }
}

/**
 * Same bands as PesaBetPro `getLossRate` / `fetchCasinoBudget`.
 * Remaining is budget + stakes − payouts. The 0.80 default is returned when the switch is off.
 */
export function lossRate(row: BudgetRow): number {
  const remaining = row.budgetTzs + (row.totalBetsTzs - row.totalPayoutsTzs)
  if (!row.enabled) return DEFAULT_LOSS_RATE
  if (remaining < row.budgetTzs * 0.2) return 0.98
  if (remaining < row.budgetTzs * 0.4) return 0.95
  if (remaining < row.budgetTzs * 0.6) return 0.88
  if (remaining > row.budgetTzs * 1.5) return 0.75
  return DEFAULT_LOSS_RATE
}

/** Admin dashboard numbers from CasinoBudgetSection, plus the rate the server actually applies. */
export function budgetView(row: BudgetRow) {
  const netProfit = row.totalBetsTzs - row.totalPayoutsTzs
  const budgetRemaining = row.budgetTzs + netProfit
  const health = budgetRemaining / Math.max(row.budgetTzs, 1)
  const payoutCap = Math.round(row.budgetTzs * 0.55)
  const payoutCapPercent = row.totalPayoutsTzs > 0 && payoutCap > 0 ? (row.totalPayoutsTzs / payoutCap) * 100 : 0
  const displayLossRate = health >= 1.5 ? 0.75 : health >= 0.6 ? 0.8 : health >= 0.4 ? 0.88 : health >= 0.2 ? 0.95 : 0.98
  const healthLabel = health >= 1.5 ? 'good' : health >= 1 ? 'normal' : health >= 0.6 ? 'caution' : health >= 0.4 ? 'recovery' : 'danger'
  return {
    budgetTzs: row.budgetTzs,
    totalBetsTzs: row.totalBetsTzs,
    totalPayoutsTzs: row.totalPayoutsTzs,
    enabled: row.enabled,
    netProfit,
    budgetRemaining,
    isRecoveryMode: row.enabled && budgetRemaining < row.budgetTzs * 0.4,
    lossRate: lossRate(row),
    displayLossRate,
    payoutCap,
    payoutCapPercent,
    isPayoutCapReached: row.totalPayoutsTzs >= payoutCap,
    health,
    healthLabel,
  }
}

export async function readCasinoBudget(client: PoolClient | { query: PoolClient['query'] }, game: CasinoGame): Promise<BudgetRow> {
  const result = await client.query<SqlRow>(
    `SELECT budget_tzs, total_bets_tzs, total_payouts_tzs, enabled FROM ${TABLES[game]} WHERE id`,
  )
  if (!result.rows[0]) throw new Error(`${TABLES[game]}_missing`)
  return mapRow(result.rows[0])
}

export async function lockCasinoBudget(client: PoolClient, game: CasinoGame): Promise<BudgetRow> {
  const result = await client.query<SqlRow>(
    `SELECT budget_tzs, total_bets_tzs, total_payouts_tzs, enabled FROM ${TABLES[game]} WHERE id FOR UPDATE`,
  )
  if (!result.rows[0]) throw new Error(`${TABLES[game]}_missing`)
  return mapRow(result.rows[0])
}

/** Same additions as recordCasinoBet + recordCasinoPayout, inside the ledger transaction. */
export async function addCasinoTurnover(client: PoolClient, game: CasinoGame, stakeTzs: number, payoutTzs: number) {
  await client.query(
    `UPDATE ${TABLES[game]}
        SET total_bets_tzs = total_bets_tzs + $1,
            total_payouts_tzs = total_payouts_tzs + $2
      WHERE id`,
    [stakeTzs, payoutTzs],
  )
}

export async function saveCasinoBudget(
  client: PoolClient,
  game: CasinoGame,
  next: { budgetTzs?: number; enabled?: boolean; resetCounters?: boolean },
): Promise<BudgetRow> {
  const sets: string[] = []
  const values: Array<number | boolean> = []
  if (next.budgetTzs !== undefined) {
    values.push(next.budgetTzs)
    sets.push(`budget_tzs = $${values.length}`)
  }
  if (next.enabled !== undefined) {
    values.push(next.enabled)
    sets.push(`enabled = $${values.length}`)
  }
  if (next.resetCounters) {
    sets.push(`total_bets_tzs = 0`, `total_payouts_tzs = 0`)
  }
  if (!sets.length) return readCasinoBudget(client, game)
  const result = await client.query<SqlRow>(
    `UPDATE ${TABLES[game]} SET ${sets.join(', ')} WHERE id
     RETURNING budget_tzs, total_bets_tzs, total_payouts_tzs, enabled`,
    values,
  )
  return mapRow(result.rows[0])
}
