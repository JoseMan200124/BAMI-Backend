export function apiKeyGuard(req, res, next) {
    const required = process.env.BAMI_API_KEY
    if (!required) return next()
    const provided = req.header('x-api-key')
    if (provided && provided === required) return next()
    return res.status(401).json({ error: 'Unauthorized' })
}
