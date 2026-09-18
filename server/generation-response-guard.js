export function createGenerationResponseGuard(history = [], limit = 1000) {
    const seen = new Map()
    const keyFor = (entry) => JSON.stringify([entry.apiId, entry.model, entry.responseId])
    const remember = (entry) => {
        seen.set(keyFor(entry), entry)
        while (seen.size > limit) seen.delete(seen.keys().next().value)
    }
    // Logs are newest first. Keep the latest bounded set across server restarts.
    for (const log of history.slice(0, limit).reverse()) {
        const responseId = log.upstream?.responseId
        if (log.status === 'success-response' && typeof responseId === 'string' && responseId.trim()) {
            remember({...log, responseId: responseId.trim()})
        }
    }
    return (entry) => {
        if (typeof entry.responseId !== 'string' || !entry.responseId.trim()) return null
        const normalized = {...entry, responseId: entry.responseId.trim()}
        const previous = seen.get(keyFor(normalized))
        if (previous) return previous
        // Check and claim synchronously so concurrent tasks cannot accept the same response.
        remember(normalized)
        return null
    }
}
