import { Router } from 'express'
import { subscribe } from '../utils/sse.js'
import { getCase } from '../store.js'

const router = Router()

router.get('/stream/:id', (req, res) => {
    const { id } = req.params
    const c = getCase(id)
    if (!c) return res.status(404).json({ error: 'case not found' })
    // Firma correcta: (req, res, id)
    subscribe(req, res, id)
})

export default router
