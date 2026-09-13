import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Account, Connection } from '../config/schema'
import type { TrueLayerAccount, TrueLayerCard, TrueLayerTransaction } from '../truelayer/types'
import type { ActualTransaction } from '../transform/transform'
import * as actual from '../actual/actual'
import * as truelayer from '../truelayer/truelayer'
import { syncAccount } from './account'

vi.mock('../actual/actual')
vi.mock('../truelayer/truelayer')
vi.mock('../utils/logger')

const baseConnection: Connection = {
  name: 'My Bank',
  accounts: [],
}

const baseAccount: Account = {
  trueLayerId: 'acc-1',
  actualId: 'actual-acc-1',
  friendlyName: 'Current Account',
}

const mockTrueLayerAccount: TrueLayerAccount = {
  account_id: 'acc-1',
  account_type: 'TRANSACTION',
  currency: 'GBP',
  display_name: 'Current Account',
  update_timestamp: '2026-04-24T00:00:00Z',
  account_number: {},
  provider: { provider_id: 'first-direct' },
}

const mockTransaction: TrueLayerTransaction = {
  transaction_id: 'txn-1',
  timestamp: '2026-04-20T10:00:00Z',
  description: 'Coffee Shop',
  amount: 3.5,
  currency: 'GBP',
  transaction_type: 'DEBIT',
  transaction_category: 'PURCHASE',
  transaction_classification: [],
}

const emptyAccountsById = new Map<string, TrueLayerAccount | TrueLayerCard>()
const trueLayerAccountsById = new Map<string, TrueLayerAccount | TrueLayerCard>([['acc-1', mockTrueLayerAccount]])

const baseOptions = {
  connection: baseConnection,
  accessToken: 'access-token',
  lookbackDays: 14,
  trueLayerAccountsById,
  includeCategoryInNotes: false,
}

describe('syncAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(truelayer.getAccountPendingTransactions).mockResolvedValue([])
    vi.mocked(truelayer.getCardPendingTransactions).mockResolvedValue([])
  })

  it('fetches account transactions and imports them', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    await syncAccount({ ...baseOptions, configAccount: baseAccount })

    expect(truelayer.getAccountTransactions).toHaveBeenCalledWith('access-token', 'acc-1', undefined)
    expect(truelayer.getAccountPendingTransactions).toHaveBeenCalledWith('access-token', 'acc-1')
    expect(actual.importTransactions).toHaveBeenCalledWith('actual-acc-1', expect.any(Array))
  })

  it('calls getCardTransactions and getCardPendingTransactions when resolveIsCard returns true', async () => {
    vi.mocked(truelayer.getCardTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    await syncAccount({ ...baseOptions, configAccount: { ...baseAccount, isCard: true } })

    expect(truelayer.getCardTransactions).toHaveBeenCalledWith('access-token', 'acc-1', undefined)
    expect(truelayer.getCardPendingTransactions).toHaveBeenCalledWith('access-token', 'acc-1')
    expect(truelayer.getAccountTransactions).not.toHaveBeenCalled()
    expect(truelayer.getAccountPendingTransactions).not.toHaveBeenCalled()
  })

  it('includes pending transactions as uncleared alongside settled ones', async () => {
    const pendingTransaction = { ...mockTransaction, transaction_id: 'txn-pending-1' }
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(truelayer.getAccountPendingTransactions).mockResolvedValueOnce([pendingTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1', 'txn-pending-1'], updated: [] })

    await syncAccount({ ...baseOptions, configAccount: baseAccount })

    const [, imported] = vi.mocked(actual.importTransactions).mock.calls[0] as [string, ActualTransaction[]]
    expect(imported).toHaveLength(2)
    expect(imported.find((t) => t.imported_id === 'txn-1')?.cleared).toBe(true)
    expect(imported.find((t) => t.imported_id === 'txn-pending-1')?.cleared).toBe(false)
  })

  it('imports pending transactions even when there are no settled transactions', async () => {
    const pendingTransaction = { ...mockTransaction, transaction_id: 'txn-pending-1' }
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([])
    vi.mocked(truelayer.getAccountPendingTransactions).mockResolvedValueOnce([pendingTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-pending-1'], updated: [] })

    const result = await syncAccount({ ...baseOptions, configAccount: baseAccount })

    expect(result).toBe(true)
    expect(actual.importTransactions).toHaveBeenCalledWith('actual-acc-1', [
      expect.objectContaining({ imported_id: 'txn-pending-1', cleared: false }),
    ])
  })

  it('passes fromDate when lastSyncDate is provided', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: [], updated: [] })

    await syncAccount({ ...baseOptions, configAccount: baseAccount, lastSyncDate: '2026-04-24' })

    expect(truelayer.getAccountTransactions).toHaveBeenCalledWith('access-token', 'acc-1', '2026-04-10')
  })

  it('does not call importTransactions when no transactions returned', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([])

    await syncAccount({ ...baseOptions, configAccount: baseAccount, trueLayerAccountsById: emptyAccountsById })

    expect(actual.importTransactions).not.toHaveBeenCalled()
  })

  it('returns true after successful import', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockResolvedValueOnce({ added: ['txn-1'], updated: [] })

    const result = await syncAccount({ ...baseOptions, configAccount: baseAccount })

    expect(result).toBe(true)
  })

  it('returns false when no transactions returned', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([])

    const result = await syncAccount({
      ...baseOptions,
      configAccount: baseAccount,
      trueLayerAccountsById: emptyAccountsById,
    })

    expect(result).toBe(false)
  })

  it('returns false when fetching transactions fails', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockRejectedValueOnce(new Error('Network error'))

    const result = await syncAccount({
      ...baseOptions,
      configAccount: baseAccount,
      trueLayerAccountsById: emptyAccountsById,
    })

    expect(result).toBe(false)
    expect(actual.importTransactions).not.toHaveBeenCalled()
  })

  it('returns false when importing transactions fails', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])
    vi.mocked(actual.importTransactions).mockRejectedValueOnce(new Error('Import error'))

    const result = await syncAccount({ ...baseOptions, configAccount: baseAccount })

    expect(result).toBe(false)
  })

  it('returns false and does not import when dryRun is true', async () => {
    vi.mocked(truelayer.getAccountTransactions).mockResolvedValueOnce([mockTransaction])

    const result = await syncAccount({ ...baseOptions, configAccount: baseAccount, dryRun: true })

    expect(result).toBe(false)
    expect(actual.importTransactions).not.toHaveBeenCalled()
  })
})
