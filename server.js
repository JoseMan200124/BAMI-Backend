// server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { apiKeyGuard } from './src/middleware/apiKey.js'
import chatRoutes from './src/routes/chat.js'
import casesRoutes from './src/routes/cases.js'
import webhookRoutes from './src/routes/webhooks.js'
import streamRoutes from './src/routes/stream.js'
import adminRoutes from './src/routes/admin.js'
import { logger } from './src/utils/logger.js'

const app = express()

/** ---------------- CORS DEV ROBUSTO ---------------- **/
const ENV_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim())

function isDevLan(hostname = '') {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.')
    )
}

const corsOpts = {
    origin(origin, cb) {
        // Permite peticiones sin Origin (curl/postman) y orígenes de dev comunes
        if (!origin) return cb(null, true)
        try {
            const u = new URL(origin)
            const allowed =
                ENV_ORIGINS.includes(origin) ||
                (u.protocol === 'http:' && isDevLan(u.hostname))
            if (allowed) return cb(null, true)
        } catch {} // URL inválida → cae a error
        return cb(new Error(`Not allowed by CORS: ${origin}`))
    },
    credentials: true, // por si en algún momento usas cookies
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
    maxAge: 86400
}

app.use(cors(corsOpts))
// Preflight explícito
app.options('*', cors(corsOpts))

/** -------------------------------------------------- **/

app.use(express.json({ limit: '10mb' }))
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'))

// Health
app.get('/health', (req, res) => res.json({ ok: true }))

/**
 * SSE público (EventSource no envía credenciales).
 * Sigue protegido por existencia del case en store.
 */
app.use('/api', streamRoutes)

// API protegida por API Key
app.use('/api', apiKeyGuard, casesRoutes)
app.use('/api', apiKeyGuard, chatRoutes)
app.use('/api', apiKeyGuard, webhookRoutes)
app.use('/api', apiKeyGuard, adminRoutes)

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }))

const PORT = process.env.PORT || 5176
app.listen(PORT, () => logger.info(`BAMI backend listo en :${PORT}`))
