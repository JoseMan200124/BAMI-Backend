import { Router } from 'express'
import { getCase, progressTo } from '../store.js'

const router = Router()

router.post('/webhooks/events', (req, res) => {
    const { caseId, type, note } = req.body || {}
    const c = getCase(caseId)
    if (!c) return res.status(404).json({ ok: false, error: 'case not found' })
    if (type === 'stuck') progressTo(caseId, 'en_revision', note || 'desatascado')
    return res.json({ ok: true })
})

export default router
