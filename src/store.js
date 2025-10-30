// src/store.js
import { logger } from './utils/logger.js'

/**
 * Persistencia en memoria (simple). En Render free se reinicia si el contenedor rota.
 * Luego puedes cambiar esto por Redis / Postgres fácilmente.
 */
const cases = new Map()   // caseId -> case
const chats = new Map()   // caseId -> [{role,content,ts}]

export const PRODUCT_RULES = {
    'Tarjeta de Crédito': ['dpi', 'selfie', 'comprobante_domicilio'],
    'Préstamo Personal': ['dpi', 'comprobante_ingresos', 'historial_crediticio'],
    'Hipoteca': ['dpi', 'constancia_ingresos', 'avaluo', 'comprobante_domicilio'],
    'PyME': ['dpi_representante', 'patente', 'estado_cuenta', 'nit']
}

export function createCase({ product, applicant, channel = 'web', owner = 'María' }) {
    const id = `C-${Math.floor(50000 + Math.random() * 40000)}`
    const required = PRODUCT_RULES[product] || []
    const c = {
        id,
        product,
        channel,
        owner,
        stage: 'requiere', // requiere → recibido → en_revision → aprobado|alternativa
        missing: [...required],
        applicant: applicant || {},
        uploaded: {}, // { dpi: {mimetype,size,originalname,ts}, ...}
        timeline: [ line('requiere', 'Expediente iniciado') ],
        percent: 10,
        created_at: new Date().toISOString()
    }
    cases.set(id, c)
    chats.set(id, []) // historial vacío de chat
    return c
}

export function getCase(id) { return cases.get(id) }
export function getAllCases() { return [...cases.values()] }

export function listMissing(id) {
    const c = getCase(id)
    return c ? c.missing : []
}

export function uploadDocs({ id, docs = [] }) {
    const c = getCase(id)
    if (!c) throw new Error('case not found')
    const before = new Set(c.missing)
    c.missing = c.missing.filter(d => !docs.includes(d))
    c.timeline.push(line('recibido', `Documentos marcados como enviados: ${docs.join(', ') || 'ninguno (simulado)'}`))
    c.stage = 'recibido'
    c.percent = Math.min(40, c.percent + 20)
    return { before: [...before], after: c.missing }
}

// Guardado de archivos reales (memoria)
export function uploadFiles({ id, files = [] }) {
    const c = getCase(id)
    if (!c) throw new Error('case not found')
    for (const f of files) {
        const key = f.fieldname
        c.uploaded[key] = {
            mimetype: f.mimetype,
            size: f.size,
            originalname: f.originalname,
            ts: new Date().toISOString()
        }
    }
    const receivedKeys = files.map(f => f.fieldname)
    c.missing = c.missing.filter(d => !receivedKeys.includes(d))
    c.timeline.push(line('recibido', `Archivos recibidos: ${receivedKeys.join(', ') || 'ninguno'}`))
    c.stage = 'recibido'
    c.percent = Math.max(c.percent, 40)
    return c
}

export function progressTo(id, stage, note = '') {
    const c = getCase(id)
    if (!c) throw new Error('case not found')
    c.stage = stage
    const percentByStage = { requiere: 10, recibido: 40, en_revision: 60, aprobado: 100, alternativa: 100 }
    c.percent = percentByStage[stage] ?? c.percent
    c.timeline.push(line(stage, note || `Estado → ${stage}`))
    return c
}

export function appendChat(id, role, content) {
    if (!chats.has(id)) chats.set(id, [])
    const arr = chats.get(id)
    arr.push({ role, content, ts: Date.now() })
    chats.set(id, arr)
    logger.info('chat+', id, role)
    return arr
}

export function getChat(id) {
    return chats.get(id) || []
}

export function toPublicCase(c) {
    return {
        id: c.id,
        product: c.product,
        channel: c.channel,
        owner: c.owner,
        stage: c.stage,
        missing: c.missing,
        percent: c.percent,
        timeline: c.timeline,
        applicant: c.applicant,
        created_at: c.created_at
    }
}

function line(type, text) {
    return { ts: new Date().toISOString(), type, text }
}
