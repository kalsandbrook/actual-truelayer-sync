import { importTransactions } from '../actual/actual'
import {
  getAccountTransactions,
  getCardTransactions,
  getAccountPendingTransactions,
  getCardPendingTransactions,
} from '../truelayer/truelayer'
import { transformTransactions } from '../transform/transform'
import { computeFromDate } from '../utils/date'
import { resolveIsCard } from '../utils/account'
import { buildImportSummary } from '../utils/logging'
import { log, logError } from '../utils/logger'
import { deleteStalePendingTransactions } from './reconcile'
import type { Account, Connection } from '../config/schema'
import type { TrueLayerAccount, TrueLayerCard, TrueLayerTransaction } from '../truelayer/types'

interface SyncAccountOptions {
  configAccount: Account
  connection: Connection
  accessToken: string
  trueLayerAccountsById: Map<string, TrueLayerAccount | TrueLayerCard>
  includeCategoryInNotes: boolean
  lookbackDays: number
  lastSyncDate?: string
  previousPendingImportedIds?: string[]
  dryRun?: boolean
}

export interface SyncAccountResult {
  hadTransactions: boolean
  pendingImportedIds: string[]
}

export async function syncAccount({
  configAccount,
  connection,
  accessToken,
  trueLayerAccountsById,
  includeCategoryInNotes,
  lookbackDays,
  lastSyncDate,
  previousPendingImportedIds = [],
  dryRun = false,
}: SyncAccountOptions): Promise<SyncAccountResult> {
  const prefix = [connection.name, configAccount.friendlyName]
  const fromDate = lastSyncDate ? computeFromDate(lastSyncDate, lookbackDays) : undefined

  log(prefix, `Fetching transactions${fromDate ? ` since ${fromDate}` : ''}...`)

  let trueLayerTransactions: TrueLayerTransaction[]
  let pendingTrueLayerTransactions: TrueLayerTransaction[]
  try {
    const isCard = resolveIsCard(configAccount, connection)
    ;[trueLayerTransactions, pendingTrueLayerTransactions] = isCard
      ? await Promise.all([
          getCardTransactions(accessToken, configAccount.trueLayerId, fromDate),
          getCardPendingTransactions(accessToken, configAccount.trueLayerId),
        ])
      : await Promise.all([
          getAccountTransactions(accessToken, configAccount.trueLayerId, fromDate),
          getAccountPendingTransactions(accessToken, configAccount.trueLayerId),
        ])
  } catch (err) {
    logError(prefix, 'Failed to fetch transactions:', err)
    return { hadTransactions: false, pendingImportedIds: [] }
  }

  const trueLayerAccount = trueLayerAccountsById.get(configAccount.trueLayerId)
  const transactions = [
    ...transformTransactions(trueLayerTransactions, configAccount, trueLayerAccount, includeCategoryInNotes),
    ...transformTransactions(
      pendingTrueLayerTransactions,
      configAccount,
      trueLayerAccount,
      includeCategoryInNotes,
      true,
    ),
  ]

  const pendingImportedIds = transactions.filter((t) => !t.cleared).map((t) => t.imported_id)

  // A transaction that was pending last run but whose imported_id isn't present anywhere in
  // this run's fetch has either settled under a different id (TrueLayer doesn't guarantee
  // stable ids across the pending→settled transition for every provider) or been cancelled.
  // Either way the old uncleared placeholder is stale and must be cleared out, or it'll sit
  // alongside a freshly-imported duplicate forever.
  const currentImportedIds = new Set(transactions.map((t) => t.imported_id))
  const staleImportedIds = previousPendingImportedIds.filter((id) => !currentImportedIds.has(id))

  if (!dryRun && staleImportedIds.length > 0) {
    try {
      await deleteStalePendingTransactions(prefix, configAccount.actualId, staleImportedIds)
    } catch (err) {
      logError(prefix, 'Failed to remove stale pending transactions:', err)
    }
  }

  if (transactions.length === 0) {
    log(prefix, '└ No transactions.')
    return { hadTransactions: false, pendingImportedIds }
  }

  const pendingSuffix = pendingTrueLayerTransactions.length > 0 ? ` (${pendingTrueLayerTransactions.length} pending)` : ''
  log(prefix, `└ Found ${transactions.length} transactions${pendingSuffix}.`)
  const dates = [...trueLayerTransactions, ...pendingTrueLayerTransactions].map((t) => t.timestamp).sort()
  const from = dates[0].slice(0, 10)
  const to = dates[dates.length - 1].slice(0, 10)

  if (dryRun) {
    log(prefix, `└ [DRY RUN] Would import ${transactions.length} transactions (${from} → ${to}).`)
    return { hadTransactions: false, pendingImportedIds }
  }

  try {
    const result = await importTransactions(configAccount.actualId, transactions)
    log(prefix, `└ ${buildImportSummary(result.added.length, result.updated.length)} (${from} → ${to}).`)
  } catch (err) {
    logError(prefix, 'Failed to import transactions:', err)
    return { hadTransactions: false, pendingImportedIds: [] }
  }

  return { hadTransactions: true, pendingImportedIds }
}
