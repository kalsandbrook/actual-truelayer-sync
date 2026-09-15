import actual from '@actual-app/api'

interface InitOptions {
  serverURL: string
  password: string
  syncId: string
  verbose: boolean
}

export async function initActual(options: InitOptions): Promise<void> {
  await actual.init({
    serverURL: options.serverURL,
    password: options.password,
    verbose: options.verbose,
    dataDir: './data',
  })
  await actual.downloadBudget(options.syncId)
}

export async function importTransactions(
  accountId: string,
  transactions: Parameters<typeof actual.importTransactions>[1],
): Promise<{ added: string[]; updated: string[] }> {
  const result = await actual.importTransactions(accountId, transactions)
  if (result.errors.length > 0) {
    throw new Error(`Import errors for account ${accountId}: ${JSON.stringify(result.errors)}`)
  }
  return { added: result.added, updated: result.updated }
}

export async function getAccounts(): Promise<Array<{ id: string; name: string; closed: boolean }>> {
  return actual.getAccounts()
}

export async function getTransactions(
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<{ id: string; imported_id?: string; cleared: boolean }[]> {
  return actual.getTransactions(accountId, startDate, endDate)
}

export async function deleteTransaction(id: string): Promise<void> {
  await actual.deleteTransaction(id)
}

export async function shutdownActual(): Promise<void> {
  await actual.shutdown()
}
