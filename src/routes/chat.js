import { Router } from 'express'
import { appendChat, getCase, toPublicCase, uploadDocs, progressTo } from '../store.js'
import { bamiChatOrchestrated } from '../utils/openaiClient.js'
import { publish } from '../utils/sse.js'

const router = Router()

router.post('/chat', async (req, res) => {
    const { caseId, message, mode = 'bami' } = req.body || {}
    if (!caseId || !message) return res.status(400).json({ error: 'caseId y message requeridos' })

    const c = getCase(caseId)
    if (!c) return res.status(404).json({ error: 'case not found' })

    // Guarda mensaje del usuario
    appendChat(caseId, 'user', message)

    // Contexto adicional (estado de expediente)
    const extra = `Case: ${JSON.stringify({
        id: c.id,
        stage: c.stage,
        missing: c.missing,
        product: c.product,
        applicant: c.applicant
    })}`

    // Llama a la IA orquestadora
    const out = await bamiChatOrchestrated({ caseId, message, extraContext: extra, mode })
    const reply = out.reply || '…'
    const acts = out.actions || {}

    // Ejecuta acciones sugeridas por la IA (idempotentes y seguras)
    try {
        // Publicaciones (narración por SSE)
        if (Array.isArray(acts.publish)) {
            acts.publish.slice(0, 6).forEach(txt => publish(caseId, { role: 'ai', text: String(txt).slice(0, 500) }))
        }

        // Marcar documentos como recibidos (solo si estaban faltantes)
        if (Array.isArray(acts.mark_docs) && acts.mark_docs.length) {
            const valid = (acts.mark_docs || []).filter(d => (c.missing || []).includes(d))
            if (valid.length) uploadDocs({ id: caseId, docs: valid })
        }

        // Avance de etapa (validado)
        if (acts.set_stage && ['requiere','recibido','en_revision','aprobado','alternativa'].includes(acts.set_stage)) {
            progressTo(caseId, acts.set_stage, 'ajuste por IA')
        }

        // Señal de escalamiento (opcional: solo narramos)
        if (acts.escalate_to_advisor) {
            publish(caseId, { role: 'ai', text: '📞 Conectándote con una persona asesora. Te avisaré en cuanto responda.' })
        }
    } catch (e) {
        // Silencioso: no romper la charla si una acción falla
    }

    // Guarda respuesta del asistente
    appendChat(caseId, 'assistant', reply)

    // Devuelve la respuesta y el case actualizado
    res.json({ reply, case: toPublicCase(getCase(caseId)) })
})

export default router
