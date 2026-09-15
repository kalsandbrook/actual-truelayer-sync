import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as actual from '../actual/actual'
import { deleteStalePendingTransactions } from './reconcile'

vi.mock('../actual/actual')
vi.mock('../utils/logger')

describe('deleteStalePendingTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when there are no stale ids', async () => {
    await deleteStalePendingTransactions(['Bank'], 'actual-acc-1', [])

    expect(actual.getTransactions).not.toHaveBeenCalled()
    expect(actual.deleteTransaction).not.toHaveBeenCalled()
  })

  it('deletes only uncleared transactions matching a stale imported_id', async () => {
    vi.mocked(actual.getTransactions).mockResolvedValueOnce([
      { id: 'row-1', imported_id: 'txn-a', cleared: false, date: '2026-04-20', amount: 350 },
      { id: 'row-2', imported_id: 'txn-b', cleared: true, date: '2026-04-20', amount: 350 },
      { id: 'row-3', imported_id: 'txn-c', cleared: false, date: '2026-04-20', amount: 350 },
    ])

    await deleteStalePendingTransactions(['Bank'], 'actual-acc-1', ['txn-a', 'txn-b'])

    expect(actual.deleteTransaction).toHaveBeenCalledTimes(1)
    expect(actual.deleteTransaction).toHaveBeenCalledWith('row-1')
  })

  it('ignores transactions with no imported_id', async () => {
    vi.mocked(actual.getTransactions).mockResolvedValueOnce([{ id: 'row-1', date: '2026-04-20', amount: 350, cleared: false }])

    await deleteStalePendingTransactions(['Bank'], 'actual-acc-1', ['txn-a'])

    expect(actual.deleteTransaction).not.toHaveBeenCalled()
  })

  it('does nothing when no existing transaction matches a stale id', async () => {
    vi.mocked(actual.getTransactions).mockResolvedValueOnce([
      { id: 'row-1', imported_id: 'txn-other', cleared: false, date: '2026-04-20', amount: 350 },
    ])

    await deleteStalePendingTransactions(['Bank'], 'actual-acc-1', ['txn-a'])

    expect(actual.deleteTransaction).not.toHaveBeenCalled()
  })
})
