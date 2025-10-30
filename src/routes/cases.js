import { Router } from 'express'
import multer from 'multer'
import {
    PRODUCT_RULES,
    createCase,
    getCase,
    toPublicCase,
    uploadDocs,
    progressTo,
    appendChat,
    uploadFiles
} from '../store.js'
import { bamiValidateCase, bamiAnalyzeDocs } from '../utils/openaiClient.js'
import { publish } from '../utils/sse.js'

const router = Router()

// Multer (memoria)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 12 }
})

// POST /api/ingest/leads  → crea expediente
router.post('/ingest/leads', (req, res) => {
    const { product = 'Tarjeta de Crédito', applicant = {}, channel = 'web' } = req.body || {}
    const c = createCase({ product, applicant, channel })
    appendChat(c.id, 'assistant', `¡Bienvenido! Abrí tu expediente ${c.id} de ${product}.`)
    res.json({ case: toPublicCase(c) })
})

// POST /api/documents → marca docs como enviados (sin archivos)
router.post('/documents', (req, res) => {
    const { id, docs = [] } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id requerido' })
    const result = uploadDocs({ id, docs })
    res.json({ ok: true, missing_after: result.after })
})

// POST /api/documents/upload → subida real + arranque IA (streaming)
router.post('/documents/upload', upload.any(), async (req, res) => {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id requerido' })
    const c = getCase(id)
    if (!c) return res.status(404).json({ error: 'case not found' })

    const files = req.files || []
    uploadFiles({ id, files })

    // Notifica inicio
    publish(id, { role: 'ai', text: `📥 Recibí ${files.length} archivo(s). Preparando lectura…` })

    // pipeline en background (sin bloquear la respuesta)
    runReadingPipeline(id, files).catch(() => {})

    res.json({ ok: true, case: toPublicCase(getCase(id)) })
})

// GET /api/tracker/:id → estado + timeline
router.get('/tracker/:id', (req, res) => {
    const c = getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'case not found' })
    res.json({ case: toPublicCase(c) })
})

// POST /api/validate/:id → validación IA manual
router.post('/validate/:id', async (req, res) => {
    const c = getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'case not found' })

    progressTo(c.id, 'en_revision', 'IA analizando')

    const result = await bamiValidateCase({ caseData: c })
    const next = result.decision === 'aprobado' ? 'aprobado' : 'alternativa'
    progressTo(c.id, next, `Decisión IA: ${result.decision}`)

    res.json({ result, case: toPublicCase(getCase(c.id)) })
})

// Opcional: forzar estado (para demos)
router.post('/tracker/:id/state', (req, res) => {
    const c = getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'case not found' })
    const { stage, note } = req.body || {}
    const updated = progressTo(c.id, stage, note || 'ajuste manual')
    res.json({ case: toPublicCase(updated) })
})

export default router

// ———————————————————————————————————————————————————————————————
// Pipeline lectura + validación
// ———————————————————————————————————————————————————————————————

async function runReadingPipeline(id, files) {
    const s = getCase(id)
    if (!s) return

    progressTo(id, 'en_revision', 'IA leyendo documentos')
    publish(id, { role: 'ai', text: '🔍 Revisando legibilidad y consistencia…' })

    const analysis = await bamiAnalyzeDocs({
        caseData: s,
        files: files.map(f => ({
            fieldname: f.fieldname,
            mimetype: f.mimetype,
            buffer_b64: f.buffer.toString('base64'),
            originalname: f.originalname,
            size: f.size
        }))
    })

    if (analysis?.summary) publish(id, { role: 'ai', text: analysis.summary })
    if (analysis?.warnings?.length) {
        publish(id, { role: 'ai', text: `⚠️ Observaciones: ${analysis.warnings.join(' · ')}` })
    }

    const result = await bamiValidateCase({ caseData: getCase(id) })
    const next = result.decision === 'aprobado' ? 'aprobado' : 'alternativa'
    progressTo(id, next, `Decisión IA: ${result.decision}`)

    publish(id, {
        role: 'ai',
        text: result.decision === 'aprobado'
            ? '✅ Aprobado. Prepararé contrato y siguientes pasos.'
            : '🔁 No aprobado. Tengo una alternativa que se ajusta a tu perfil.'
    })
}
