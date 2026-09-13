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
  dryRun?: boolean
}

export async function syncAccount({
  configAccount,
  connection,
  accessToken,
  trueLayerAccountsById,
  includeCategoryInNotes,
  lookbackDays,
  lastSyncDate,
  dryRun = false,
}: SyncAccountOptions): Promise<boolean> {
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
    return false
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

  if (transactions.length === 0) {
    log(prefix, '└ No transactions.')
    return false
  }

  const pendingSuffix = pendingTrueLayerTransactions.length > 0 ? ` (${pendingTrueLayerTransactions.length} pending)` : ''
  log(prefix, `└ Found ${transactions.length} transactions${pendingSuffix}.`)
  const dates = [...trueLayerTransactions, ...pendingTrueLayerTransactions].map((t) => t.timestamp).sort()
  const from = dates[0].slice(0, 10)
  const to = dates[dates.length - 1].slice(0, 10)

  if (dryRun) {
    log(prefix, `└ [DRY RUN] Would import ${transactions.length} transactions (${from} → ${to}).`)
    return false
  }

  try {
    const result = await importTransactions(configAccount.actualId, transactions)
    log(prefix, `└ ${buildImportSummary(result.added.length, result.updated.length)} (${from} → ${to}).`)
  } catch (err) {
    logError(prefix, 'Failed to import transactions:', err)
    return false
  }

  return true
}
