// src/routes/admin.js
import { Router } from 'express'
import { getAllCases } from '../store.js'

const router = Router()
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'bami-demo-token'

// Login demo
router.post('/admin/login', (req, res) => {
    const { email, password } = req.body || {}
    if (email === 'prueba@correo.com' && password === '12345') {
        return res.json({ token: ADMIN_TOKEN })
    }
    return res.status(401).json({ error: 'Credenciales inválidas' })
})

// Guard simple por token Bearer
router.use('/admin', (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (token === ADMIN_TOKEN) return next()
    return res.status(401).json({ error: 'Unauthorized' })
})

// Analytics
router.get('/admin/analytics', (req, res) => {
    const rows = getAllCases()
    const totals = {
        cases: rows.length,
        aprobados: rows.filter(r => r.stage === 'aprobado').length,
        alternativas: rows.filter(r => r.stage === 'alternativa').length,
        en_revision: rows.filter(r => r.stage === 'en_revision').length,
        missing_avg: rows.length ? rows.reduce((a, r) => a + (r.missing?.length || 0), 0) / rows.length : 0,
        approval_rate: rows.length ? rows.filter(r => r.stage === 'aprobado').length / rows.length : 0
    }
    const funnel = ['requiere','recibido','en_revision','aprobado','alternativa']
        .reduce((acc, s) => (acc[s] = rows.filter(r => r.stage === s).length, acc), {})
    const by_product = rows.reduce((acc, r) => (acc[r.product] = (acc[r.product] || 0) + 1, acc), {})

    const leads = rows
        .slice()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50)
        .map(r => ({
            id: r.id,
            product: r.product,
            channel: r.channel,
            applicant: r.applicant,
            stage: r.stage,
            missing_count: r.missing?.length || 0,
            created_at: r.created_at
        }))

    res.json({ totals, funnel, by_product, leads })
})

router.get('/admin/cases', (req, res) => {
    const rows = getAllCases().map(c => ({
        id: c.id, product: c.product, stage: c.stage, channel: c.channel, created_at: c.created_at
    }))
    res.json({ items: rows })
})

export default router
