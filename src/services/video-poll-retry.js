// Only retry queries, never creation: a failed POST may already have been billed.
export function isRetryableVideoQuery(error) {
  const cause = error?.cause || error
  if (cause?.name === 'AbortError' || cause?.code === 'ERR_CANCELED') return false
  const status = cause?.response?.status
  if (status) return status === 408 || status === 429 || status >= 500
  return ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(cause?.code)
    || /fetch failed|failed to fetch|network error/i.test(cause?.message || '')
}

export const videoQueryRetryDelay = failures => Math.min(4000 * 2 ** (failures - 1), 30000)
