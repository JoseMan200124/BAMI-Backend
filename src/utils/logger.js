// src/utils/logger.js
/* Logger mínimo para no romper imports en server y store */
export const logger = {
    info: (...a) => console.log('[INFO]', ...a),
    warn: (...a) => console.warn('[WARN]', ...a),
    error: (...a) => console.error('[ERROR]', ...a),
}
