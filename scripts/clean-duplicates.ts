#!/usr/bin/env tsx
/**
 * Targeted cleanup for the imported_id-scheme duplicate bug: a since-reverted change
 * briefly derived imported_id from normalised_provider_transaction_id (a bare 32-hex
 * string) instead of transaction_id (prefixed "txn-..."). Any transaction imported
 * while that was live now has a duplicate sibling next to the original.
 *
 * Groups transactions per account by (date, amount, imported_payee, notes) and, within
 * each group, identifies the row(s) whose imported_id is a bare 32-hex string as the
 * duplicate — keeping the "txn-"-prefixed original. Groups that don't cleanly fit this
 * shape (wrong counts, no txn- original, etc.) are left alone and reported separately.
 *
 * DEFAULT MODE IS DRY RUN — it only prints what it would delete. Nothing is deleted
 * unless you pass --delete.
 *
 * Local:  npm run clean-duplicates -- [--days=365] [--delete]
 * Docker: docker compose run --rm actual-truelayer-sync npm run clean-duplicates -- --days=365
 */

import { loadConfig } from '../src/config/config'
import { initActual, getTransactions, deleteTransaction, shutdownActual } from '../src/actual/actual'
import { computeFromDate, currentDate } from '../src/utils/date'
import type { ActualTransactionRow } from '../src/actual/actual'

const TXN_ID_RE = /^txn-/
const HEX_ID_RE = /^[0-9a-f]{32}$/

function formatAmount(pence: number): string {
  return `${pence < 0 ? '-' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`
}

function parseArgs(argv: string[]): { days: number; execute: boolean } {
  const daysArg = argv.find((a) => a.startsWith('--days='))
  const days = daysArg ? Number(daysArg.split('=')[1]) : 365
  return {
    days: Number.isFinite(days) && days > 0 ? days : 365,
    execute: argv.includes('--delete'),
  }
}

async function main(): Promise<void> {
  const { days, execute } = parseArgs(process.argv.slice(2))
  const config = await loadConfig()
  const fromDate = computeFromDate(currentDate(), days)
  const toDate = currentDate()

  console.log(
    `\nScanning ${fromDate} to ${toDate} (--days=${days}) for imported_id-scheme duplicates. ` +
      `Mode: ${execute ? 'DELETE' : 'DRY RUN (pass --delete to actually remove rows)'}\n`,
  )

  await initActual({
    serverURL: config.env.ACTUAL_SERVER_URL,
    password: config.env.ACTUAL_SERVER_PASSWORD,
    syncId: config.env.ACTUAL_SYNC_ID,
    verbose: false,
  })

  let totalToDelete = 0
  let totalSkippedGroups = 0

  try {
    for (const connection of config.connections) {
      for (const configAccount of connection.accounts) {
        const transactions = await getTransactions(configAccount.actualId, fromDate, toDate)

        const groups = new Map<string, ActualTransactionRow[]>()
        for (const t of transactions) {
          const key = `${t.date}|${t.amount}|${t.imported_payee ?? ''}|${t.notes ?? ''}`
          const group = groups.get(key)
          if (group) {
            group.push(t)
          } else {
            groups.set(key, [t])
          }
        }

        const toDelete: ActualTransactionRow[] = []
        const skipped: ActualTransactionRow[][] = []

        for (const group of groups.values()) {
          if (group.length < 2) continue

          const originals = group.filter((t) => t.imported_id && TXN_ID_RE.test(t.imported_id))
          const duplicates = group.filter((t) => t.imported_id && HEX_ID_RE.test(t.imported_id))

          // Only act when the group cleanly splits into a matching number of originals
          // and hex-id duplicates with nothing left over — anything else is ambiguous
          // (could be a coincidental same-day/same-amount/same-payee transaction) and
          // is reported separately rather than guessed at.
          if (originals.length > 0 && originals.length === duplicates.length && originals.length + duplicates.length === group.length) {
            toDelete.push(...duplicates)
          } else {
            skipped.push(group)
          }
        }

        if (toDelete.length === 0 && skipped.length === 0) {
          continue
        }

        console.log(`── ${connection.name} / ${configAccount.friendlyName} ──`)

        if (toDelete.length > 0) {
          console.log(`  Would delete ${toDelete.length} duplicate row(s):`)
          for (const t of toDelete) {
            console.log(`    id=${t.id}  ${t.date}  ${formatAmount(t.amount)}  imported_id=${t.imported_id}  payee="${t.imported_payee ?? ''}"`)
          }
          totalToDelete += toDelete.length

          if (execute) {
            for (const t of toDelete) {
              await deleteTransaction(t.id)
            }
            console.log(`  Deleted ${toDelete.length} row(s).`)
          }
        }

        if (skipped.length > 0) {
          console.log(`  Skipped ${skipped.length} ambiguous group(s) (left untouched):`)
          for (const group of skipped) {
            console.log(`    ${group[0]!.date}  ${formatAmount(group[0]!.amount)}  payee="${group[0]!.imported_payee ?? ''}"  (${group.length} rows)`)
            for (const t of group) {
              console.log(`      id=${t.id}  cleared=${t.cleared}  imported_id=${t.imported_id ?? '(none)'}`)
            }
          }
          totalSkippedGroups += skipped.length
        }
        console.log('')
      }
    }
  } finally {
    await shutdownActual()
  }

  console.log(
    `${execute ? 'Deleted' : 'Would delete'} ${totalToDelete} row(s) total. ` +
      `${totalSkippedGroups} group(s) skipped as ambiguous — review those manually.`,
  )
  if (!execute && totalToDelete > 0) {
    console.log('Re-run with --delete once you\'ve reviewed this list to actually remove them.')
  }
}

void main().catch((err) => {
  console.error('Failed to clean duplicates:', err)
  process.exit(1)
})
