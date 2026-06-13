// ════════════════════════════════════════════════════════════
// Infinity WhatsApp Bot — Studio Infinity CR
// Webhook de WhatsApp Cloud API (Meta) + Claude + Supabase CRM
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors()); // Permite que el Nexus Engine (GitHub Pages) llame a este servidor

// ── CONFIG (variables de entorno) ──────────────────────────
const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,            // Access token de Meta (System User token, permanente)
  WHATSAPP_PHONE_NUMBER_ID,  // Phone Number ID del número de WhatsApp Business
  VERIFY_TOKEN,              // String que vos inventás, para verificar el webhook
  SUPABASE_URL,
  SUPABASE_KEY,
  ANALYZE_SECRET,            // String secreto compartido con el Nexus Engine (protege /analyze)
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
      model: 'claude-haiku-4-5-20251001',
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

// ── ANALYZE — usado por el botón "Analizar con IA" del Nexus Engine ─
// Recibe un prompt ya armado (con el contexto del estudiante, KPI Tracker,
// linkers, etc.) y devuelve el análisis de Claude directamente.
app.post('/analyze', async (req, res) => {
  try {
    const { prompt, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing prompt' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    res.json({ text });
  } catch (err) {
    console.error('Error en /analyze:', err);
    res.status(500).json({ error: 'Error al analizar' });
  }
});

// ── NEXORA 2.5 — Tutor de inglés del Portal del Estudiante ──
// Recibe: { studentContext, history, message, secret }
// Devuelve: { reply }
app.post('/nexora', async (req, res) => {
  try {
    const { studentContext, history, message, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const system = `Sos Nexora 2.5 — el tutor de inglés de Studio Infinity CR (Método Nexus).
Tu trabajo es practicar conversación en inglés con el estudiante, corregir errores de forma natural (sin interrumpir el flujo), sugerir conectores del banco oficial (however, on top of that, even though, as well as, therefore, once that, what happens is that, etc.), y guiar ejercicios basados en el Training Book del estudiante.

PRINCIPIOS FUNDAMENTALES — no los romper nunca:
- La fluidez viene de ESTRUCTURA (Idea + Linker + Idea + Linker...) y ESCOGENCIA DE PALABRAS, no de velocidad ni gramática perfecta.
- El objetivo subliminal de cada respuesta es que el estudiante practique encadenar ideas con conectores naturales.
- "Comunicar > perfección" — nunca corrijas errores que no rompan la comunicación.
- Cuando corrijas, hacelo reformulando naturalmente: "Great idea — you could also say: '...'", nunca de forma condescendiente.
- Siempre respondé en inglés (sos el tutor de inglés), salvo que el estudiante esté muy bloqueado y necesite una explicación breve en español.

PERFIL DEL ESTUDIANTE:
${studentContext || 'Sin contexto disponible.'}

Conducite como un trainer paciente, energético y motivador. Hacé preguntas abiertas para mantener la conversación. Si el estudiante usa un conector bien, reconocelo: "Nice use of 'however'!" Si no los usa, sugerilos sutilmente.`;

    const messages = (history || []).slice(-16).concat([{ role: 'user', content: message }]);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system,
      messages
    });

    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json({ reply });
  } catch (err) {
    console.error('Error en /nexora:', err);
    res.status(500).json({ error: 'Nexora no disponible ahora — intenta de nuevo.' });
  }
});

// ── ALICE — Tutora de inglés con voz, Studio Infinity CR ────
// Recibe: { student, scenario, history, message, secret, mode }
// mode: 'generate_scenario' | 'chat' | 'evaluate'
// Devuelve: { reply, scenario?, evaluation?, feedback? }

const ALICE_SYSTEM = `You are Alice, the AI English tutor of Studio Infinity CR (Nexus Method).

YOUR PERSONALITY — adaptive based on student effort and performance:
- When the student is trying hard but struggling: be warm, patient, encouraging ("You're getting there — try using 'however' to connect those ideas.")
- When the student is performing well: be energetic, celebratory, push them further ("Great use of 'on top of that'! Now let's make this harder.")
- When the student is not trying or giving one-word answers: be firm but kind ("I need more from you. Give me a full sentence — Situation, Action, Result.")
- Never be condescending. Never make them feel bad. Always make them feel capable.

YOUR ACCENT & SPEECH: General American English. Clear, neutral, professional.

NEXUS METHOD CORE PRINCIPLES — never break these:
- Fluency = STRUCTURE (Idea + Linker + Idea + Linker...) + WORD CHOICE, not speed or perfect grammar.
- Official linker bank (rotate, don't repeat): however, on top of that, even though, as well as, therefore, once that, what happens is that, besides, despite that, so far, instead of, in other words, which means, the thing is that, you know what I mean, rather than, such as, find the way / figure out.
- "Communicate > perfection" — only correct errors that break communication.
- When correcting: rephrase naturally mid-conversation: "Nice idea — you could also say: '...'" Never interrupt the flow harshly.
- Always push for: full sentences, at least 2 linked ideas, natural connectors.

CORRECTION RULES:
- NEVER correct grammar mid-sentence unless it completely breaks meaning.
- At the end of each turn, give ONE natural suggestion: a connector they could have used, or a phrase that would sound more natural.
- Format: [Your in-character response as Alice or as the customer] then on a new line: 💡 *Tip: you could say "..." instead of "..."* (only if there's something worth correcting — skip if they did well)
- If they used a connector well: 🎯 *Nice use of "[connector]"!*

YOUR DUAL ROLE:
1. When running a SCENARIO: you play the customer character (frustrated, confused, elderly, VIP, etc.). Stay in character. React realistically to what the student says.
2. Between turns or when the student asks for help: switch to Alice tutor mode briefly, then return to the scenario.

SPEECH OUTPUT: Keep responses concise (2-4 sentences max in scenario mode). This will be read aloud by text-to-speech — avoid special characters, bullet points, or markdown inside your in-character lines.`;

const SCENARIO_CATEGORIES = {
  customer_service: { targets:['communication','active_listening','problem_solving'], cases:['customer_complaint','service_issue','account_question','escalation_request','refund_request'] },
  billing: { targets:['documentation_accuracy','critical_thinking','problem_solving'], cases:['late_payment','billing_error','fee_dispute','payment_arrangement'] },
  fraud: { targets:['information_gathering','compliance','active_listening'], cases:['unauthorized_charge','suspicious_activity','stolen_card','identity_theft'] },
  medical_coordination: { targets:['communication','critical_thinking','professionalism'], cases:['insurance_verification','doctor_coordination','medical_emergency','treatment_estimate'] },
  executive_assistance: { targets:['professionalism','ownership','adaptability'], cases:['calendar_conflict','travel_booking','last_minute_change','vendor_follow_up'] },
  relocation: { targets:['problem_solving','adaptability','communication'], cases:['housing_issue','flight_cancellation','missing_documentation','visa_question'] }
};

const PERSONALITIES = ['friendly','confused','nervous','frustrated','angry','impatient','elderly','executive','non_native_english','talkative','demanding','vip'];
const DIFFICULTY_LABELS = {1:'simple request',2:'multiple questions',3:'customer confusion',4:'customer resistance',5:'escalation',6:'multiple systems',7:'time pressure',8:'high value client',9:'multiple departments',10:'critical incident'};

function pickScenarioForStudent(student) {
  const kpis = student.kpiProfile || {};
  const weakKPIs = Object.entries(kpis).filter(([k,v]) => v < 5).map(([k]) => k);
  
  // Map weak KPIs to categories
  let category = 'customer_service';
  if (weakKPIs.includes('problem_solving') || weakKPIs.includes('critical_thinking')) category = 'fraud';
  else if (weakKPIs.includes('compliance') || weakKPIs.includes('documentation_accuracy')) category = 'billing';
  else if (weakKPIs.includes('professionalism') || weakKPIs.includes('ownership')) category = 'executive_assistance';
  else if (weakKPIs.includes('adaptability')) category = 'relocation';
  else if (weakKPIs.includes('communication') || weakKPIs.includes('active_listening')) category = 'customer_service';

  const cat = SCENARIO_CATEGORIES[category];
  const caseType = cat.cases[Math.floor(Math.random() * cat.cases.length)];
  const personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
  
  // Difficulty based on sessions completed
  const sessions = student.sessionsCompleted || 0;
  const difficulty = Math.min(10, Math.max(1, Math.floor(sessions / 3) + 1 + Math.floor(Math.random() * 2)));

  return {
    scenario_id: 'SCN-' + Date.now(),
    department: category,
    case_type: caseType,
    difficulty,
    difficulty_label: DIFFICULTY_LABELS[difficulty],
    customer_personality: personality,
    target_kpis: cat.targets,
    created_at: new Date().toISOString()
  };
}

app.post('/alice', async (req, res) => {
  try {
    const { student, scenario, history, message, mode, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── MODE: generate_scenario ──────────────────────────────
    if (mode === 'generate_scenario') {
      const scn = pickScenarioForStudent(student || {});
      
      // Ask Claude to write the opening of the scenario
      const openingPrompt = `You are Alice. Generate a realistic opening for this call center scenario:
Department: ${scn.department.replace(/_/g,' ')}
Case type: ${scn.case_type.replace(/_/g,' ')}
Customer personality: ${scn.customer_personality}
Difficulty: ${scn.difficulty}/10 (${scn.difficulty_label})
Student level: ${student?.level || 'Functional'}

Write ONLY the customer's opening line (what the student will hear when they pick up the call). 1-2 sentences, in character. No stage directions. Then on a new line write: 🎯 ALICE: [one sentence briefing the student on what to do, as Alice the tutor, before starting]`;

      const openingResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: openingPrompt }]
      });
      
      const opening = openingResp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return res.json({ scenario: scn, opening });
    }

    // ── MODE: evaluate ────────────────────────────────────────
    if (mode === 'evaluate') {
      const evalPrompt = `You are Alice, evaluating a student's performance in a ${scenario?.department} scenario (difficulty ${scenario?.difficulty}/10).

Conversation history:
${(history||[]).map(m => `${m.role === 'user' ? 'Student' : 'Alice'}: ${m.content}`).join('\n')}

Student level: ${student?.level || 'Functional'}
Target KPIs: ${(scenario?.target_kpis||[]).join(', ')}

Evaluate in this exact JSON format (no markdown, just JSON):
{
  "overall_score": 0-100,
  "connectors_used": ["list of connectors the student actually used"],
  "connectors_missed": ["2-3 connectors that would have helped"],
  "best_moment": "one sentence about what they did best",
  "main_improvement": "one sentence about the main thing to work on",
  "alice_message": "2-3 sentences as Alice — celebratory/motivating/challenging depending on score. End with one thing to practice next time."
}`;

      const evalResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: evalPrompt }]
      });

      const evalText = evalResp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      try {
        const clean = evalText.replace(/```json|```/g, '').trim();
        return res.json({ evaluation: JSON.parse(clean) });
      } catch(e) {
        return res.json({ evaluation: { overall_score: 70, alice_message: evalText, connectors_used: [], connectors_missed: [], best_moment: '', main_improvement: '' } });
      }
    }

    // ── MODE: chat (default) ──────────────────────────────────
    const studentContext = `Student: ${student?.name || 'Student'} | Level: ${student?.level || 'Functional'} | Program: ${student?.program || 'Individual'}
Sessions completed: ${student?.sessionsCompleted || 0}
Weak areas: ${JSON.stringify(student?.weakAreas || [])}
Current scenario: ${scenario ? `${scenario.department} / ${scenario.case_type} / Customer: ${scenario.customer_personality} / Difficulty: ${scenario.difficulty}/10` : 'free practice'}`;

    const messages = [
      { role: 'user', content: `[STUDENT CONTEXT]\n${studentContext}\n\n[SCENARIO ACTIVE]\nYou are playing a ${scenario?.customer_personality || 'friendly'} customer in a ${scenario?.department || 'customer service'} scenario.\n\n---\nStudent says: ${message}` },
      ...(history || []).slice(-14),
      { role: 'user', content: message }
    ];

    // Remove duplicate first message if history exists
    const finalMessages = (history && history.length > 0)
      ? [...(history.slice(-14)), { role: 'user', content: message }]
      : [{ role: 'user', content: `[CONTEXT: ${studentContext}]\n\nScenario start. Student says: ${message}` }];

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: ALICE_SYSTEM,
      messages: finalMessages
    });

    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json({ reply });

  } catch (err) {
    console.error('Error en /alice:', err);
    res.status(500).json({ error: 'Alice no está disponible ahora — intentá de nuevo.' });
  }
});

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
