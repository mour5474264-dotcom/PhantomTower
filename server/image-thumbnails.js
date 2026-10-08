import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

// Bound full-size decodes even when an entire gallery becomes visible at once.
export function createThumbnailCache({directory, loadImage, sharp, concurrency = 2}) {
    const pending = new Map()
    const waiting = []
    let active = 0
    async function withSlot(work) {
        if (active >= concurrency) await new Promise(resolve => waiting.push(resolve))
        else active += 1
        try { return await work() }
        finally {
            const next = waiting.shift()
            if (next) next()
            else active -= 1
        }
    }
    return function thumbnail(source) {
        if (pending.has(source)) return pending.get(source)
        const task = (async () => {
            const key = crypto.createHash('sha256').update(source).digest('hex')
            const file = path.join(directory, `${key}-640-v1.webp`)
            try { return await fs.readFile(file) }
            catch (error) { if (error.code !== 'ENOENT') throw error }
            return withSlot(async () => {
                const {buffer} = await loadImage(source)
                const thumbnail = await sharp()(buffer, {failOn: 'none'})
                    .rotate().resize({width: 640, height: 640, fit: 'inside', withoutEnlargement: true})
                    .webp({quality: 80}).toBuffer()
                await fs.mkdir(directory, {recursive: true})
                const temporary = `${file}.${crypto.randomUUID()}.tmp`
                try {
                    await fs.writeFile(temporary, thumbnail)
                    await fs.rename(temporary, file)
                } finally {
                    await fs.rm(temporary, {force: true}).catch(() => {})
                }
                return thumbnail
            })
        })().finally(() => pending.delete(source))
        pending.set(source, task)
        return task
    }
}
