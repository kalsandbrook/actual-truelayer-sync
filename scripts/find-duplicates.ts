#!/usr/bin/env tsx
/**
 * Read-only report of likely duplicate transactions per account.
 *
 * Groups each account's transactions by (date, amount) and prints any group with
 * more than one entry. It does NOT delete or modify anything — review the output
 * yourself and decide what (if anything) to remove in the Actual UI.
 *
 * Local:  npm run find-duplicates -- [--days=90]
 * Docker: docker compose run --rm actual-truelayer-sync npm run find-duplicates -- --days=90
 */

import { loadConfig } from '../src/config/config'
import { initActual, getTransactions, shutdownActual } from '../src/actual/actual'
import { computeFromDate, currentDate } from '../src/utils/date'

function formatAmount(pence: number): string {
  return `${pence < 0 ? '-' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`
}

function parseDaysArg(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith('--days='))
  const days = arg ? Number(arg.split('=')[1]) : 90
  return Number.isFinite(days) && days > 0 ? days : 90
}

async function main(): Promise<void> {
  const days = parseDaysArg(process.argv.slice(2))
  const config = await loadConfig()
  const fromDate = computeFromDate(currentDate(), days)
  const toDate = currentDate()

  console.log(`\nScanning transactions from ${fromDate} to ${toDate} (--days=${days}) for likely duplicates...\n`)

  await initActual({
    serverURL: config.env.ACTUAL_SERVER_URL,
    password: config.env.ACTUAL_SERVER_PASSWORD,
    syncId: config.env.ACTUAL_SYNC_ID,
    verbose: false,
  })

  let totalGroups = 0
  let totalExtraRows = 0

  try {
    for (const connection of config.connections) {
      for (const configAccount of connection.accounts) {
        const transactions = await getTransactions(configAccount.actualId, fromDate, toDate)

        const groups = new Map<string, typeof transactions>()
        for (const t of transactions) {
          const key = `${t.date}|${t.amount}`
          const group = groups.get(key)
          if (group) {
            group.push(t)
          } else {
            groups.set(key, [t])
          }
        }

        const duplicateGroups = [...groups.values()].filter((g) => g.length > 1)
        if (duplicateGroups.length === 0) {
          continue
        }

        console.log(`── ${connection.name} / ${configAccount.friendlyName} ──`)
        for (const group of duplicateGroups) {
          totalGroups++
          totalExtraRows += group.length - 1
          console.log(`  ${group[0]!.date}  ${formatAmount(group[0]!.amount)}  (${group.length} matching rows)`)
          for (const t of group) {
            console.log(
              `    id=${t.id}  cleared=${t.cleared ?? false}  imported_id=${t.imported_id ?? '(none)'}  payee="${t.imported_payee ?? '(none)'}"  notes="${t.notes ?? ''}"`,
            )
          }
        }
        console.log('')
      }
    }
  } finally {
    await shutdownActual()
  }

  if (totalGroups === 0) {
    console.log('No same-account/date/amount groups with more than one transaction found in this window.')
  } else {
    console.log(
      `Found ${totalGroups} group(s) with ${totalExtraRows} extra row(s) beyond the first. ` +
        `This is a same-date/same-amount match only — some of these may be legitimate (e.g. two separate ` +
        `£7.59 purchases on the same day). Review payee/notes above before deleting anything.`,
    )
  }
}

void main().catch((err) => {
  console.error('Failed to scan for duplicates:', err)
  process.exit(1)
})
