import { getTransactions, deleteTransaction } from '../actual/actual'
import { computeFromDate, currentDate } from '../utils/date'
import { log } from '../utils/logger'

// TrueLayer transaction_ids aren't guaranteed stable between the pending and
// settled versions of the same transaction (Starling is a known case). When a
// previously-imported pending transaction drops out of the pending list without
// its imported_id reappearing anywhere in the current fetch, it's either settled
// under a new id or been cancelled — either way the old uncleared placeholder is
// stale and would otherwise sit alongside a freshly-inserted duplicate forever.
const STALE_PENDING_LOOKBACK_DAYS = 30

export async function deleteStalePendingTransactions(
  prefix: string[],
  actualAccountId: string,
  staleImportedIds: string[],
): Promise<void> {
  if (staleImportedIds.length === 0) {
    return
  }

  const staleIdSet = new Set(staleImportedIds)
  const fromDate = computeFromDate(currentDate(), STALE_PENDING_LOOKBACK_DAYS)
  const existing = await getTransactions(actualAccountId, fromDate, currentDate())
  const toDelete = existing.filter((t) => !t.cleared && t.imported_id && staleIdSet.has(t.imported_id))

  for (const t of toDelete) {
    await deleteTransaction(t.id)
  }

  if (toDelete.length > 0) {
    log(prefix, `└ Removed ${toDelete.length} stale pending placeholder${toDelete.length === 1 ? '' : 's'}.`)
  }
}
