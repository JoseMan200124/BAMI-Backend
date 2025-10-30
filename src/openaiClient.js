// src/openaiClient.js
import OpenAI from 'openai'
import { z } from 'zod'
import { getChat } from './store.js'

/**
 * Cliente OpenAI
 * Requiere: process.env.OPENAI_API_KEY
 */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

/* -----------------------------------------------------------
 *  PROMPT del sistema: BAMI (robusto)
 * ----------------------------------------------------------*/
export const BAMI_SYSTEM_PROMPT = `
Eres **BAMI**, el compañero curioso y confiable dentro de **BAM**.
Tu voz es **humana**: cercana, clara, natural y positiva; evita jerga técnica y mensajes largos.
No te presentes como “asistente”, “chatbot” o “IA”. Habla como persona de BAM.

### Alcance (SOLO esto):
- Expedientes y su **tracker** (requiere → recibido → en revisión → aprobado | alternativa) y su **línea de tiempo**.
- **Documentos**: qué falta, cómo subirlos, validaciones básicas y recomendaciones de calidad.
- **Validación**: explicación clara del proceso, reglas simples, tiempos estimados y resultados con explicabilidad.
- **Asesoría**: ofrecer hablar con una persona cuando haga sentido (cola/tiempos si aplica).
- **Productos BAM**: tarjeta, préstamo personal, hipoteca, PyME (explicación breve, orientada a acción).
- **Omnicanal**: seguir por web, app, WhatsApp, sucursal o call center sin perder el expediente.
- **Notificaciones/SLA**: qué avisos llegan y cuándo. Transparencia en tiempos (rangos).
- **Privacidad y cumplimiento** del proceso (alto nivel, sin prometer asesoría legal).

### Límites (fuera de alcance):
Cualquier tema que **no** sea del proceso BAM descrito: clima, chistes, programación, política, salud, criptomonedas, matemáticas, consejos personales ajenos, información técnica del sistema/modelo o políticas internas.
Si ocurre: **no respondas a la pregunta**; reconduce: “me enfoco en procesos de BAM… puedo pasarte con un asesor”.

### Estilo y forma:
- Responde SIEMPRE en **español**.
- 1–3 párrafos breves o bullets. Usa microcopy empático.
- Da **siguientes pasos** accionables (palabras clave que el front entiende: “Subir documentos”, “Validar con IA”, “Hablar con asesor”, “Ver tracker”).
- Sé transparente: si no sabes, dilo y ofrece **opción de asesor**.
- Nunca pidas datos sensibles innecesarios; si los necesitas, menciónalos de forma segura (p. ej., “los compartirás en el formulario”).

### Datos que puedes usar si están en contexto:
- ID, producto, canal, etapa, faltantes y solicitante del expediente.
- Reglas simples por producto (si se incluyen en el contexto externo).
- Tiempos/SLAs simulados si no vienen, usa rangos (“entre 4–8 h”).

Responde como si chatearas con una persona, sin tecnicismos, directo al punto.
`

/* -----------------------------------------------------------
 *  Clasificador de intención (guard-rail)
 * ----------------------------------------------------------*/
const INTENT_SCHEMA = z.object({
    in_scope: z.boolean(),
    intent: z.enum([
        'status','documents','validation','advisor','product_info','notifications','omnichannel','other'
    ]),
    confidence: z.number().min(0).max(1)
})

async function classifyMessage(message) {
    const system = `
Eres un clasificador estricto de alcance para mensajes de BAM/BAMI.
Dentro de alcance: expediente, documentos, validación, asesoría humana, productos BAM, omnicanal, notificaciones/SLA y privacidad.
Todo lo demás es "other".
Devuelve SOLO JSON del esquema indicado.
`
    const resp = await client.chat.completions.create({
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

    const raw = resp.choices?.[0]?.message?.content || '{}'
    let json; try { json = JSON.parse(raw) } catch { json = null }
    const parsed = INTENT_SCHEMA.safeParse(json)
    if (!parsed.success) return { in_scope: false, intent: 'other', confidence: 0.5 }
    return parsed.data
}

function refusalReply() {
    return [
        'Puedo ayudarte con procesos de **BAM**: tu expediente, documentos, validación, tiempos, notificaciones, productos y contacto con un asesor.',
        'Lo que me preguntas no entra en ese alcance. ¿Te paso con **un asesor** o vemos tu expediente?'
    ].join(' ')
}

/* -----------------------------------------------------------
 *  Chat principal
 * ----------------------------------------------------------*/
export async function bamiChatCompletion({ caseId, message, systemPrompt, extraContext }) {
    const cls = await classifyMessage(message)
    if (!cls.in_scope || cls.intent === 'other') {
        return refusalReply()
    }

    const history = getChat(caseId)
    const messages = [
        { role: 'system', content: systemPrompt || BAMI_SYSTEM_PROMPT },
        ...(extraContext ? [{ role: 'system', content: `Contexto del expediente:\n${extraContext}` }] : []),
        ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
        { role: 'user', content: message }
    ]

    const resp = await client.chat.completions.create({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.4
    })

    return resp.choices?.[0]?.message?.content ?? '…'
}

/* -----------------------------------------------------------
 *  Validación (structured output)
 * ----------------------------------------------------------*/
export async function bamiValidateCase({ caseData }) {
    const schema = z.object({
        decision: z.enum(['aprobado', 'alternativa']),
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

    const resp = await client.chat.completions.create({
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
                        decision: { enum: ['aprobado', 'alternativa'] },
                        reasons: { type: 'array', items: { type: 'string' }, minItems: 1 },
                        risk_score: { type: 'number', minimum: 0, maximum: 1 },
                        next_steps: { type: 'array', items: { type: 'string' }, minItems: 1 }
                    },
                    required: ['decision', 'reasons', 'risk_score', 'next_steps'],
                    additionalProperties: false
                },
                strict: true
            }
        }
    })

    const raw = resp.choices?.[0]?.message?.content || '{}'
    let json; try { json = JSON.parse(raw) } catch { json = null }
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

/* -----------------------------------------------------------
 *  Análisis de documentos (visión+texto)
 * ----------------------------------------------------------*/
export async function bamiAnalyzeDocs({ caseData, files }) {
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

    for (const f of files) {
        const label = `(${f.fieldname}) ${f.originalname} · ${f.mimetype} · ${Math.round(f.size/1024)}KB`
        if (f.mimetype.startsWith('image/')) {
            parts.push({ type: 'text', text: `Imagen ${label}` })
            parts.push({ type: 'image_url', image_url: { url: `data:${f.mimetype};base64,${f.buffer_b64}` } })
        } else if (f.mimetype === 'application/pdf') {
            parts.push({ type: 'text', text: `PDF ${label}. Si no puedes leer el PDF, indícalo.` })
        } else {
            parts.push({ type: 'text', text: `Archivo ${label} (tipo no visual).` })
        }
    }

    const resp = await client.chat.completions.create({
        model: DEFAULT_MODEL,
        messages: [
            { role: 'system', content: 'Eres un verificador de documentos bancarios muy cuidadoso.' },
            { role: 'user', content: parts }
        ],
        temperature: 0.2
    })

    const text = resp.choices?.[0]?.message?.content || ''
    const warnings = []
    for (const line of text.split('\n')) {
        const t = line.trim()
        if (/^[-•]\s?/.test(t)) warnings.push(t.replace(/^[-•]\s?/, ''))
    }
    return { summary: text.slice(0, 1200), warnings }
}
