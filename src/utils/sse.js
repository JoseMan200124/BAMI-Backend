// src/utils/sse.js{
import { EventEmitter } from 'events'

const channels = new Map()  // caseId -> Set(res)

function ensureSet(id) {
    if (!channels.has(id)) channels.set(id, new Set())
    return channels.get(id)
}

export function subscribe(req, res, id) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const set = ensureSet(id)
    set.add(res)

    // ping keep-alive
    const ping = setInterval(() => {
        try { res.write(':\n\n') } catch {}
    }, 15000)

    req.on('close', () => {
        clearInterval(ping)
        set.delete(res)
        try { res.end() } catch {}
    })
}

export function publish(id, payload) {
    const set = channels.get(id)
    if (!set || !set.size) return
    const data = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of set) {
        try { res.write(data) } catch {}
    }
}
