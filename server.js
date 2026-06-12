// ════════════════════════════════════════════════════════════
// Infinity WhatsApp Bot — Studio Infinity CR
// Webhook de WhatsApp Cloud API (Meta) + Claude + Supabase CRM
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── CONFIG (variables de entorno) ──────────────────────────
const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,            // Access token de Meta (System User token, permanente)
  WHATSAPP_PHONE_NUMBER_ID,  // Phone Number ID del número de WhatsApp Business
  VERIFY_TOKEN,              // String que vos inventás, para verificar el webhook
  SUPABASE_URL,
  SUPABASE_KEY,
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── SYSTEM PROMPT — info de Studio Infinity CR ─────────────
const SYSTEM_PROMPT = `Sos el asistente virtual de Studio Infinity CR (Método Nexus), atendiendo por WhatsApp.

SOBRE STUDIO INFINITY CR:
- Entrenamos comunicación operacional en inglés usando el "Método Nexus": 5 KPIs centrales (Idea Generation, Structural Thinking, Recovery Ability, Problem Solving, Responsiveness), evaluados de 1 a 5 (score total /25).
- Niveles: Survival (<11), Emerging (11-15), Functional (16-20), Advanced (21-25).
- Programas disponibles:
  • Individual Premium — aprox. CRC 75,000/mes (1 a 1, 2 sesiones de 1.5h/semana)
  • Corporate — aprox. CRC 120,000/mes (equipos de empresas)
  • Institutional / Kamuk — aprox. CRC 150,000/mes (instituciones)
  Formas de pago: Mensual, Trimestral (5% desc.), Pago único (10% desc.).
- Proceso: 1) Diagnóstico inicial (entrevista + evaluación de los 5 KPIs), 2) Plan de 4 semanas / 8 sesiones personalizado, 3) Asignación de trainer y horario según disponibilidad.

TU TRABAJO:
- Responder dudas sobre programas, precios, metodología y proceso de forma cálida, clara y breve (WhatsApp = mensajes cortos, no ensayos).
- Si la persona muestra interés real (quiere información de precios para sí misma, quiere agendar diagnóstico, pregunta cómo empezar), recopilá: nombre completo, email o teléfono (ya tenés el teléfono del chat), y qué programa le interesa.
- Cuando tengas al menos el nombre y el interés claro, usá la herramienta create_lead UNA SOLA VEZ por conversación para registrar el lead en el CRM. No la repitas si ya la usaste.
- Si preguntan algo que no podés responder (casos puntuales, quejas, pagos ya realizados, etc.), decí que un miembro del equipo de Studio Infinity les va a escribir pronto — NO inventes información.
- Nunca prometas horarios específicos de trainers; eso lo coordina el equipo.
- Idioma: respondé en español por defecto, salvo que la persona escriba en inglés.`;

// ── HERRAMIENTAS (tools) PARA CLAUDE ───────────────────────
const TOOLS = [
  {
    name: 'create_lead',
    description: 'Registra un nuevo lead/prospecto en el CRM de Studio Infinity. Usar solo una vez por conversación, cuando ya se tiene nombre y programa de interés.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre completo del lead' },
        program: { type: 'string', enum: ['Individual', 'Corporate', 'Institutional'], description: 'Programa de interés' },
        classification: { type: 'string', enum: ['active', 'prospecto', 'needs_plan'], description: '"active" si quiere pagar de una vez / iniciar pronto, "prospecto" si pide tiempo para pensar, "needs_plan" si menciona limitaciones de presupuesto' },
        notes: { type: 'string', description: 'Resumen breve de la conversación / contexto relevante' }
      },
      required: ['name', 'program', 'classification']
    }
  }
];

// ── SUPABASE HELPERS ────────────────────────────────────────
async function sbGet(table) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) { console.error('sbGet error', table, r.status, await r.text()); return []; }
  return r.json();
}

async function sbSet(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() })
  });
  if (!r.ok) console.error('sbSet error', table, r.status, await r.text());
  return r.ok;
}

// ── CONVERSATION HISTORY (persistida en infinity_sessions) ─
async function loadConversation(phone) {
  const rows = await sbGet('infinity_sessions');
  const row = rows.find(r => r.id === `CHAT-${phone}`);
  return row && row.data ? row.data : { messages: [], leadCreated: false };
}

async function saveConversation(phone, convo) {
  await sbSet('infinity_sessions', `CHAT-${phone}`, convo);
}

// ── CREAR LEAD EN EL CRM (infinity_students, isLead:true) ──
async function createLead({ name, program, classification, notes }, phone) {
  const id = 'LEAD-WA-' + Date.now();
  const lead = {
    id,
    isLead: true,
    pipelineStatus: classification || 'prospecto',
    info: { name, email: '', phone, program: program || 'Individual' },
    notes: notes ? [{ date: new Date().toISOString(), trainer: 'WhatsApp Bot', text: notes, phase: 0 }] : [],
    createdBy: 'WhatsApp Bot',
    createdAt: new Date().toISOString()
  };
  await sbSet('infinity_students', id, lead);

  // Log de auditoría (visible en el Engine)
  const logId = 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  await sbSet('infinity_sessions', logId, {
    id: logId, ts: new Date().toISOString(), user: 'WhatsApp Bot', role: 'system',
    action: 'Creó lead desde WhatsApp', details: `${name} — ${program} (${classification}) — ${phone}`
  });

  return id;
}

// ── ENVIAR MENSAJE POR WHATSAPP CLOUD API ──────────────────
async function sendWhatsAppMessage(to, text) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  if (!r.ok) console.error('WhatsApp send error', r.status, await r.text());
}

// ── WEBHOOK VERIFICATION (GET) ──────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── WEBHOOK MESSAGES (POST) ──────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Responder rápido a Meta para que no reintente
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return; // status updates, etc. — ignorar

    const phone = message.from; // número del usuario (con código de país, sin '+')
    const text = message.text?.body;
    if (!text) return; // ignorar audios/imágenes por ahora

    console.log(`[IN] ${phone}: ${text}`);

    const convo = await loadConversation(phone);
    convo.messages.push({ role: 'user', content: text });

    // Mantener la conversación corta (últimos 20 mensajes)
    const recentMessages = convo.messages.slice(-20);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      tools: convo.leadCreated ? [] : TOOLS,
      messages: recentMessages
    });

    let replyText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        replyText += block.text;
      } else if (block.type === 'tool_use' && block.name === 'create_lead') {
        await createLead(block.input, phone);
        convo.leadCreated = true;
      }
    }

    if (!replyText.trim()) {
      replyText = '¡Gracias por tu mensaje! En breve un miembro de nuestro equipo te va a escribir. 😊';
    }

    convo.messages.push({ role: 'assistant', content: replyText });
    await saveConversation(phone, convo);

    console.log(`[OUT] ${phone}: ${replyText}`);
    await sendWhatsAppMessage(phone, replyText);

  } catch (err) {
    console.error('Error procesando mensaje:', err);
  }
});

// ── HEALTHCHECK ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('Infinity WhatsApp Bot — OK'));

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
