export function adminAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
    const expected = process.env.BAMI_ADMIN_TOKEN || 'bami-admin-demo'
    if (token && token === expected) return next()
    return res.status(401).json({ error: 'Unauthorized' })
}
