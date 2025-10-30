// src/utils/openaiClient.js
// -----------------------------------------------------------------------------
// BAMI · Orquestador con OpenAI (Chat + Validación + Análisis de documentos)
// Requisitos:
//   - npm i openai zod
//   - Variables de entorno: OPENAI_API_KEY, (opcional) OPENAI_MODEL
// -----------------------------------------------------------------------------

import OpenAI from 'openai'
import { z } from 'zod'
import { getChat } from '../store.js'

// ————————————————————————————————————————————————
// Cliente OpenAI
// ————————————————————————————————————————————————
if (!process.env.OPENAI_API_KEY) {
    console.warn('[BAMI][OpenAI] Falta OPENAI_API_KEY. El backend no podrá responder vía modelo.')
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

// ————————————————————————————————————————————————
// Utilidades
// ————————————————————————————————————————————————
function safeParseJSON(raw, fallback = null) { try { return JSON.parse(raw) } catch { return fallback } }
async function withTimeout(promise, ms = 45_000) {
    let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms) })
    try { return await Promise.race([promise, timeout]) } finally { clearTimeout(t) }
}
function parseCaseFromExtra(extraContext) {
    try {
        const m = String(extraContext || '').match(/Case:\s*(\{.*\})\s*$/s)
        return m ? JSON.parse(m[1]) : null
    } catch { return null }
}
function formatTracker6(stage = 'requiere') {
    const steps = [
        { k: 1, t: 'Datos Recibidos' },
        { k: 2, t: 'Filtros Iniciales' },
        { k: 3, t: 'Clasificación (Sort)' },
        { k: 4, t: 'Filtro de Datos' },
        { k: 5, t: 'Solicitud de Datos Extra' },
        { k: 6, t: 'Aprobación' }
    ]
    const done = new Set(['recibido','en_revision','aprobado','alternativa'])
    const marks = steps.map((s, i) => {
        if (stage === 'aprobado') return `${s.k}. ${s.t} ✅`
        if (stage === 'alternativa') return `${s.k}. ${s.t} ${i < 4 ? '✅' : '◻️'}`
        if (stage === 'en_revision') return `${s.k}. ${s.t} ${i < 3 ? '✅' : (i === 3 ? '(En curso) ◻️' : '◻️')}`
        if (stage === 'recibido') return `${s.k}. ${s.t} ${i < 2 ? '✅' : '◻️'}`
        return `${s.k}. ${s.t} ${i === 0 ? '✅' : '◻️'}`
    })
    return marks.join('\n')
}
function fallbackReply(extraContext) {
    const c = parseCaseFromExtra(extraContext) || {}
    const missing = Array.isArray(c.missing) ? c.missing : []
    const missingTxt = missing.length ? `Faltan: ${missing.join(', ')}.` : 'No hay faltantes. Podemos pasar a revisión.'
    const tracker = formatTracker6(c.stage || 'requiere')
    return {
        reply: [
            `Te acompaño con tu solicitud de ${c.product || 'producto'}.`,
            `Estado: **${(c.stage || 'requiere').replace('_',' ')}**.`,
            missingTxt,
            '',
            '**Tracker:**\n' + tracker,
            '',
            '¿Deseas que valide con IA ahora, subir documentos o hablar con un asesor?'
        ].join('\n')
    }
}

// ————————————————————————————————————————————————
// Prompt orquestador (guiones/flows integrados + few-shots)
// ————————————————————————————————————————————————
const FEWSHOTS = `
[EJEMPLOS GUIADOS — NO RESPONDAS ESTOS, SÓLO IMITA EL ESTILO]

Usuario: "¡Hola! Quiero aplicar para una Tarjeta de Crédito."
Respuesta BAMI (JSON):
{
  "reply": "¡Hola! Soy BAMI 🤝 Te acompaño en el proceso. ¿Ya eres cliente BAM? Para continuar, abre la Subida Guiada y allí ingresas tu DPI (no por chat). Cuando subas DPI y constancia, te avisaré cada etapa por WhatsApp y App.",
  "actions": { "publish": ["📥 Recibí tus documentos (cuando los subas).", "🔍 Envío a revisión."], "set_stage": "recibido" }
}

Usuario: "BAMI, ¿en qué va mi solicitud de Credifácil?"
Respuesta BAMI (JSON):
{
  "reply": "He localizado tu solicitud. Vamos en etapa 4: Filtro de Datos. Tiempo estimado ~2 días hábiles. Tracker:\\n1. Datos Recibidos ✓\\n2. Filtros Iniciales ✓\\n3. Clasificación (Sort) →\\n4. Filtro de Datos (En curso) ◻️\\n5. Solicitud de Datos Extra ◻️\\n6. Aprobación",
  "actions": { "publish": ["📡 Consulté tu expediente."], "notify": ["app","whatsapp"] }
}

Usuario: "Estoy frustrado, no me deja subir la constancia."
Respuesta BAMI (JSON):
{
  "reply": "Lamento la molestia 😕. Veo que la constancia tiene más de 3 meses; para esta etapa debe ser reciente. Puedo guiarte para subir la versión vigente o conectarte con una persona asesora.",
  "actions": { "escalate_to_advisor": true }
}
`

export const BAMI_ORCHESTRATOR_PROMPT = `
Eres **BAMI**, compañero digital curioso y confiable del **BAM**.
Voz: cercana, clara, natural, positiva. 1–3 párrafos o bullets. Transparente.
Enfócate SOLO en: expediente/seguimiento, documentos, validación, tiempos/SLA,
notificaciones, productos (TC, Préstamo, Hipoteca, PyME) y contacto con asesor.

### Mapeos y sinónimos
- "credifácil" o "credi facil" ≈ **Préstamo Personal**.
- "tc" o "tarjeta" ≈ **Tarjeta de Crédito**.

### Regla de seguridad
- Nunca pidas datos sensibles completos en el chat. Si se necesitan, dile que
  se ingresarán en el formulario de subida y enmascara ejemplos (DPI ****1234).

### Estados y reglas
- Estados del expediente: **requiere → recibido → en_revision → aprobado | alternativa**.
- Reglas por producto (alto nivel): Tarjeta de Crédito → **dpi, selfie, comprobante_domicilio**;
  Préstamo → **dpi, comprobante_ingresos, historial_crediticio**;
  Hipoteca → **dpi, constancia_ingresos, avaluo, comprobante_domicilio**;
  PyME → **dpi_representante, patente, estado_cuenta, nit**.

### Guiones operativos (ajústalos al contexto real del case):
1) **Aplicar a Tarjeta de Crédito:** Saluda empático. DPI sólo en formulario (no en chat).
   Indica **Subir docs** guiado. Cuando el usuario confirme subida de DPI/ingresos:
   usa \`actions.publish\` para narración ("📥 Recibí…", "🔍 Envié a revisión…") y
   podrás proponer \`set_stage\` a "recibido" o "en_revision".
2) **Seguimiento "¿en qué va?" (Credifácil/Préstamo):** Responde con tracker de 6 pasos
   (como en los ejemplos) y TTA de etapa 4 ≈ **2 días hábiles**.
3) **Error subiendo papelería:** Responde con empatía. Causa típica: constancia >3 meses.
   Ofrece (a) subir versión vigente, (b) hablar con asesor (\`escalate_to_advisor: true\`).

### Detección de fricción
- Si el usuario expresa frustración/error ("no me deja", "error", "estoy frustrado"): reconoce, explica con claridad y propone asesor.

### Formato de salida (JSON ESTRICTO):
- \`reply\` (string): respuesta final natural.
- \`actions\` (obj opcional):
  - \`publish\` (string[] opcional)
  - \`set_stage\` ∈ { requiere | recibido | en_revision | aprobado | alternativa } (opcional)
  - \`mark_docs\` (string[] opcional)
  - \`escalate_to_advisor\` (boolean opcional)
  - \`notify\` ⊆ { "app","whatsapp","email" } (opcional)

### Reglas de orquestación
- **No inventes uploads ni estados**: sólo marca si el usuario lo indicó.
- Incluye \`publish\` en confirmaciones de subida.
- En "¿en qué va?", incluye tracker textual breve.
- Sé humano y breve; evita texto redundante.

${FEWSHOTS}

Devuelve SOLO JSON válido.
`

// ————————————————————————————————————————————————
// Esquemas Zod (structured outputs)
// ————————————————————————————————————————————————
const ACTIONS_SCHEMA = z.object({
    reply: z.string(),
    actions: z.object({
        publish: z.array(z.string()).optional(),
        set_stage: z.enum(['requiere','recibido','en_revision','aprobado','alternativa']).optional(),
        mark_docs: z.array(z.string()).optional(),
        escalate_to_advisor: z.boolean().optional(),
        notify: z.array(z.enum(['app','whatsapp','email'])).optional()
    }).optional()
})

const INTENT_SCHEMA = z.object({
    in_scope: z.boolean(),
    intent: z.enum(['status','documents','validation','advisor','product_info','notifications','omnichannel','other']),
    confidence: z.number().min(0).max(1)
})

// ————————————————————————————————————————————————
// Clasificador de intención (guard-rail básico)
// ————————————————————————————————————————————————
async function classifyMessage(message) {
    const system = `
Eres un clasificador estricto de alcance para mensajes de BAM/BAMI.
Dentro de alcance: expediente, documentos, validación, asesoría humana, productos BAM,
omnicanal, notificaciones/SLA y privacidad. Todo lo demás es "other".
Devuelve SOLO JSON del esquema indicado.
`
    const resp = await withTimeout(
        client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: `Clasifica este mensaje:\n"${message}"` }
            ],
            temperature: 0,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'BAMIIntent',
                    schema: {
                        type: 'object',
                        properties: {
                            in_scope: { type: 'boolean' },
                            intent: { type: 'string', enum: ['status','documents','validation','advisor','product_info','notifications','omnichannel','other'] },
                            confidence: { type: 'number', minimum: 0, maximum: 1 }
                        },
                        required: ['in_scope','intent','confidence'],
                        additionalProperties: false
                    },
                    strict: true
                }
            }
        })
    )
    const raw = resp.choices?.[0]?.message?.content || '{}'
    const json = safeParseJSON(raw)
    const parsed = INTENT_SCHEMA.safeParse(json)
    if (!parsed.success) return { in_scope: true, intent: 'status', confidence: 0.5 }
    return parsed.data
}

// ————————————————————————————————————————————————
// Chat orquestado: { reply, actions }
// ————————————————————————————————————————————————
export async function bamiChatOrchestrated({ caseId, message, extraContext = '', mode = 'bami' }) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada')

    // Guard-rail
    const cls = await classifyMessage(message)
    if (!cls.in_scope || cls.intent === 'other') {
        const fb = fallbackReply(extraContext)
        return {
            reply: [
                'Puedo ayudarte con procesos de **BAM**: tu expediente, documentos, validación, tiempos, notificaciones, productos y contacto con un asesor.',
                fb.reply
            ].join('\n\n'),
            actions: {}
        }
    }

    // Historial (→ Chat Completions)
    const history = (getChat(caseId) || []).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
    }))

    // Matiz por modo
    const rolePrompt =
        mode === 'ia'
            ? 'Estilo: técnico, conciso (máximo 2 frases), sin adornos.'
            : mode === 'asesor'
                ? 'Estilo: persona asesora, empática, soluciones claras, próximos pasos.'
                : 'Estilo: BAMI estándar (humano, claro, positivo).'

    const messages = [
        { role: 'system', content: BAMI_ORCHESTRATOR_PROMPT + '\n' + rolePrompt },
        ...(extraContext ? [{ role: 'system', content: `Contexto del expediente:\n${extraContext}` }] : []),
        ...history,
        { role: 'user', content: message }
    ]

    try {
        const resp = await withTimeout(
            client.chat.completions.create({
                model: DEFAULT_MODEL,
                messages,
                temperature: 0.3,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'BAMIOrchestrator',
                        schema: {
                            type: 'object',
                            properties: {
                                reply: { type: 'string' },
                                actions: {
                                    type: 'object',
                                    properties: {
                                        publish: { type: 'array', items: { type: 'string' } },
                                        set_stage: { type: 'string', enum: ['requiere','recibido','en_revision','aprobado','alternativa'] },
                                        mark_docs: { type: 'array', items: { type: 'string' } },
                                        escalate_to_advisor: { type: 'boolean' },
                                        notify: { type: 'array', items: { type: 'string', enum: ['app','whatsapp','email'] } }
                                    },
                                    additionalProperties: false
                                }
                            },
                            required: ['reply'],
                            additionalProperties: false
                        },
                        strict: true
                    }
                }
            }),
            45_000
        )

        const raw = resp.choices?.[0]?.message?.content || '{}'
        const parsed = ACTIONS_SCHEMA.safeParse(safeParseJSON(raw))
        if (!parsed.success) return fallbackReply(extraContext)
        return parsed.data
    } catch {
        // Respuesta determinista si hay error de red/timeout, etc.
        return fallbackReply(extraContext)
    }
}

// ————————————————————————————————————————————————
// Validación de expediente (riesgo/decisión)
// ————————————————————————————————————————————————
export async function bamiValidateCase({ caseData }) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada')

    const schema = z.object({
        decision: z.enum(['aprobado','alternativa']),
        reasons: z.array(z.string()).min(1),
        risk_score: z.number().min(0).max(1),
        next_steps: z.array(z.string()).min(1)
    })

    const system = `
Actúas como analista de riesgo de BAM.
Evalúa con empatía y transparencia considerando:
- Documentos faltantes
- Coherencia de datos del solicitante
- Reglas simples según producto
Devuelve SOLO JSON válido del esquema.
`

    const resp = await withTimeout(
        client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: `Expediente:\n${JSON.stringify(caseData, null, 2)}` },
                { role: 'user', content: 'Genera la evaluación ahora. SOLO JSON.' }
            ],
            temperature: 0,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'BAMIValidation',
                    schema: {
                        type: 'object',
                        properties: {
                            decision: { enum: ['aprobado','alternativa'] },
                            reasons: { type: 'array', items: { type: 'string' }, minItems: 1 },
                            risk_score: { type: 'number', minimum: 0, maximum: 1 },
                            next_steps: { type: 'array', items: { type: 'string' }, minItems: 1 }
                        },
                        required: ['decision','reasons','risk_score','next_steps'],
                        additionalProperties: false
                    },
                    strict: true
                }
            }
        }),
        45_000
    )

    const raw = resp.choices?.[0]?.message?.content || '{}'
    const json = safeParseJSON(raw)
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
        return {
            decision: 'alternativa',
            reasons: ['No se pudo estructurar la respuesta del analizador.'],
            risk_score: 0.7,
            next_steps: ['Revisar documentos con un asesor', 'Volver a intentar la validación']
        }
    }
    return parsed.data
}

// ————————————————————————————————————————————————
// Análisis de documentos (visión/legibilidad)
// ————————————————————————————————————————————————
export async function bamiAnalyzeDocs({ caseData, files }) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada')

    const parts = []
    parts.push({
        type: 'text',
        text: `Analiza los documentos de un expediente de BAM.

Objetivo:
- Verifica legibilidad, coincidencias básicas (nombre/ID), vigencia.
- Señala posibles riesgos (borrosidad, recortes, discrepancias, caducidad).
- No inventes datos: si no puedes leer algo, dilo explícitamente.

Responde en español con un resumen y advertencias si aplica.`
    })

    for (const f of (files || [])) {
        const label = `(${f.fieldname}) ${f.originalname} · ${f.mimetype} · ${Math.round(f.size / 1024)}KB`
        if (f.mimetype?.startsWith('image/')) {
            parts.push({ type: 'text', text: `Imagen ${label}` })
            parts.push({ type: 'image_url', image_url: { url: `data:${f.mimetype};base64,${f.buffer_b64}` } })
        } else if (f.mimetype === 'application/pdf') {
            parts.push({ type: 'text', text: `PDF ${label}. Si no puedes leer el PDF, indícalo.` })
        } else {
            parts.push({ type: 'text', text: `Archivo ${label} (tipo no visual).` })
        }
    }

    const resp = await withTimeout(
        client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
                { role: 'system', content: 'Eres un verificador de documentos bancarios muy cuidadoso.' },
                { role: 'user', content: parts }
            ],
            temperature: 0.2
        }),
        60_000
    )

    const text = resp.choices?.[0]?.message?.content || ''
    const warnings = []
    for (const line of text.split('\n')) {
        const t = line.trim()
        if (/^[-•]\s?/.test(t)) warnings.push(t.replace(/^[-•]\s?/, ''))
    }
    return { summary: text.slice(0, 1200), warnings }
}
