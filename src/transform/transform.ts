import type { TrueLayerTransaction, TrueLayerAccount, TrueLayerCard } from '../truelayer/types'

import { Account } from '../config/schema'

export interface ActualTransaction {
  account: string
  date: string
  amount: number
  payee_name: string
  imported_id: string
  notes?: string
  cleared: boolean
}

export function shouldFlipAmount(
  configAccount: Account,
  trueLayerAccount: TrueLayerAccount | TrueLayerCard | undefined,
): boolean {
  // Determine flip: explicit config takes precedence, then infer from card_type === 'CREDIT'
  if (configAccount.flip !== undefined) {
    return configAccount.flip
  }

  if (trueLayerAccount !== undefined && 'card_type' in trueLayerAccount && trueLayerAccount.card_type === 'CREDIT') {
    return true
  }

  return false
}

export function toActualAmount(amount: number, shouldFlip: boolean): number {
  const pence = Math.round(amount * 100)
  return pence === 0 ? 0 : pence * (shouldFlip ? -1 : 1)
}

function getDescription(trueLayerTransaction: TrueLayerTransaction): string {
  return trueLayerTransaction.description.replace(/,?\s*Transaction Date:\s*\d{4}-\d{2}-\d{2}/i, '').trim()
}

export function getPayeeName(trueLayerTransaction: TrueLayerTransaction): string {
  const candidates = [
    trueLayerTransaction.merchant_name,
    trueLayerTransaction.meta?.provider_merchant_name,
    trueLayerTransaction.meta?.counter_party_preferred_name,
  ]

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== '') {
      return candidate.trim()
    }
  }

  return getDescription(trueLayerTransaction)
}

export function transformTransaction(
  trueLayerTransaction: TrueLayerTransaction,
  configAccount: Account,
  trueLayerAccount: TrueLayerAccount | TrueLayerCard | undefined,
  includeCategoryInNotes: boolean,
  pending = false,
): ActualTransaction {
  const description = getDescription(trueLayerTransaction)
  const payeeName = getPayeeName(trueLayerTransaction)

  const noteParts = []
  if (includeCategoryInNotes && trueLayerTransaction.transaction_category !== 'UNKNOWN') {
    noteParts.push(trueLayerTransaction.transaction_category)
  }
  if (payeeName !== description) {
    noteParts.push(description)
  }

  return {
    account: configAccount.actualId,
    date: trueLayerTransaction.timestamp.split('T')[0]!,
    amount: toActualAmount(trueLayerTransaction.amount, shouldFlipAmount(configAccount, trueLayerAccount)),
    payee_name: payeeName,
    imported_id: trueLayerTransaction.normalised_provider_transaction_id ?? trueLayerTransaction.transaction_id,
    notes: noteParts.length > 0 ? noteParts.join(' | ') : undefined,
    cleared: !pending,
  }
}

export function transformTransactions(
  trueLayerTransactions: TrueLayerTransaction[],
  configAccount: Account,
  trueLayerAccount: TrueLayerAccount | TrueLayerCard | undefined,
  includeCategoryInNotes: boolean,
  pending = false,
): ActualTransaction[] {
  return trueLayerTransactions.map((t) =>
    transformTransaction(t, configAccount, trueLayerAccount, includeCategoryInNotes, pending),
  )
}
