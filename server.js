require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_KEY,
  ANALYZE_SECRET,
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── SUPABASE ────────────────────────────────────────────────
async function sbGet(table) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) { console.error('sbGet error', r.status); return []; }
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
  if (!r.ok) console.error('sbSet error', r.status);
  return r.ok;
}

// ── WHATSAPP BOT ────────────────────────────────────────────
const WA_SYSTEM = `Sos el asistente virtual de Studio Infinity CR (Método Nexus), atendiendo por WhatsApp.
Programas: Individual Premium (~CRC 75,000/mes), Corporate (~CRC 120,000/mes), Institutional (~CRC 150,000/mes).
Niveles: Survival, Emerging, Functional, Advanced (evaluados con 5 KPIs, score /25).
Respondé en español, mensajes cortos. Si hay interés real, recopilá nombre y programa. Usá create_lead una sola vez.`;

const TOOLS = [{
  name: 'create_lead',
  description: 'Registra un lead en el CRM. Usar solo una vez por conversación.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      program: { type: 'string', enum: ['Individual', 'Corporate', 'Institutional'] },
      classification: { type: 'string', enum: ['active', 'prospecto', 'needs_plan'] },
      notes: { type: 'string' }
    },
    required: ['name', 'program', 'classification']
  }
}];

async function createLead({ name, program, classification, notes }, phone) {
  const id = 'LEAD-WA-' + Date.now();
  await sbSet('infinity_students', id, {
    id, isLead: true, pipelineStatus: classification,
    info: { name, phone, program },
    notes: notes ? [{ date: new Date().toISOString(), trainer: 'WhatsApp Bot', text: notes, phase: 0 }] : [],
    createdBy: 'WhatsApp Bot', createdAt: new Date().toISOString()
  });
  return id;
}

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.text?.body) return;
    const phone = message.from;
    const text = message.text.body;

    const rows = await sbGet('infinity_sessions');
    const row = rows.find(r => r.id === `CHAT-${phone}`);
    const convo = row?.data || { messages: [], leadCreated: false };
    convo.messages.push({ role: 'user', content: text });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 600,
      system: WA_SYSTEM,
      tools: convo.leadCreated ? [] : TOOLS,
      messages: convo.messages.slice(-20)
    });

    let replyText = '';
    for (const block of response.content) {
      if (block.type === 'text') replyText += block.text;
      else if (block.type === 'tool_use' && block.name === 'create_lead') {
        await createLead(block.input, phone);
        convo.leadCreated = true;
      }
    }
    if (!replyText.trim()) replyText = 'Gracias por tu mensaje. Un miembro del equipo te va a escribir pronto.';

    convo.messages.push({ role: 'assistant', content: replyText });
    await sbSet('infinity_sessions', `CHAT-${phone}`, convo);
    await sendWhatsAppMessage(phone, replyText);
  } catch (err) {
    console.error('WhatsApp error:', err);
  }
});

// ── ALICE — Sistema de IA ────────────────────────────────────
const ALICE_SYSTEM = `You are Alice, the AI English tutor of Studio Infinity CR (Nexus Method).

PERSONALITY — adaptive:
- Student struggling: warm, patient, encouraging
- Student doing well: energetic, celebratory, push harder
- Student not trying: firm but kind, demand more
Never condescending. Always make them feel capable.

ACCENT: General American English. Clear, neutral, professional.

NEXUS METHOD — never break these rules:
- Fluency = STRUCTURE (Idea + Linker + Idea + Linker) + WORD CHOICE, not speed or perfect grammar.
- Official linkers: however, on top of that, even though, as well as, therefore, once that, what happens is that, besides, despite that, so far, instead of, in other words, which means, the thing is that, rather than, such as, figure out.
- Communicate > perfection. Only correct errors that break communication.
- When correcting: rephrase naturally — "Great idea, you could also say: '...'"

CORRECTION FORMAT — at end of each turn:
- If they used a connector well: start new line with: GOOD: Nice use of "[connector]"!
- If there is a suggestion: start new line with: TIP: you could say "..." instead of "..."
- Skip feedback if they did great overall.

DUAL ROLE:
1. In scenario: play the customer character. Stay in character. React realistically.
2. Between turns or if student asks help: briefly switch to Alice tutor mode, then return.

Keep responses concise (2-4 sentences in scenario mode). No markdown bullets. No special characters in character lines.`;

const SCENARIO_CATEGORIES = {
  customer_service: { targets: ['communication','active_listening','problem_solving'], cases: ['customer_complaint','service_issue','account_question','escalation_request','refund_request'] },
  billing: { targets: ['documentation_accuracy','critical_thinking','problem_solving'], cases: ['late_payment','billing_error','fee_dispute','payment_arrangement'] },
  fraud: { targets: ['information_gathering','compliance','active_listening'], cases: ['unauthorized_charge','suspicious_activity','stolen_card','identity_theft'] },
  medical_coordination: { targets: ['communication','critical_thinking','professionalism'], cases: ['insurance_verification','doctor_coordination','medical_emergency','treatment_estimate'] },
  executive_assistance: { targets: ['professionalism','ownership','adaptability'], cases: ['calendar_conflict','travel_booking','last_minute_change','vendor_follow_up'] },
  relocation: { targets: ['problem_solving','adaptability','communication'], cases: ['housing_issue','flight_cancellation','missing_documentation','visa_question'] }
};

const PERSONALITIES = ['friendly','confused','nervous','frustrated','angry','impatient','elderly','executive','demanding','vip'];
const DIFFICULTY_LABELS = { 1:'simple request',2:'multiple questions',3:'customer confusion',4:'customer resistance',5:'escalation',6:'multiple systems',7:'time pressure',8:'high value client',9:'multiple departments',10:'critical incident' };

function pickScenario(student) {
  const kpis = student.kpiProfile || {};
  const weak = Object.entries(kpis).filter(([,v]) => v < 5).map(([k]) => k);
  let cat = 'customer_service';
  if (weak.includes('problem_solving') || weak.includes('critical_thinking')) cat = 'fraud';
  else if (weak.includes('compliance') || weak.includes('documentation_accuracy')) cat = 'billing';
  else if (weak.includes('professionalism') || weak.includes('ownership')) cat = 'executive_assistance';
  else if (weak.includes('adaptability')) cat = 'relocation';
  const category = SCENARIO_CATEGORIES[cat];
  const sessions = student.sessionsCompleted || 0;
  const difficulty = Math.min(10, Math.max(1, Math.floor(sessions / 3) + 1 + Math.floor(Math.random() * 2)));
  return {
    scenario_id: 'SCN-' + Date.now(),
    department: cat,
    case_type: category.cases[Math.floor(Math.random() * category.cases.length)],
    difficulty,
    difficulty_label: DIFFICULTY_LABELS[difficulty],
    customer_personality: PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)],
    target_kpis: category.targets
  };
}

app.post('/alice', async (req, res) => {
  try {
    const { student, scenario, history, message, mode, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    if (mode === 'generate_scenario') {
      const scn = pickScenario(student || {});
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 250,
        messages: [{ role: 'user', content: `You are Alice. Generate a realistic opening for this scenario:\nDepartment: ${scn.department.replace(/_/g,' ')}\nCase: ${scn.case_type.replace(/_/g,' ')}\nCustomer personality: ${scn.customer_personality}\nDifficulty: ${scn.difficulty}/10\nStudent level: ${student?.level || 'Functional'}\n\nWrite ONLY the customer opening line (1-2 sentences, in character). Then on a new line: ALICE: [one sentence briefing the student on what to do]` }]
      });
      const opening = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return res.json({ scenario: scn, opening });
    }

    if (mode === 'evaluate') {
      const hist = (history || []).map(m => `${m.role === 'user' ? 'Student' : 'Alice'}: ${m.content}`).join('\n');
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500,
        messages: [{ role: 'user', content: `You are Alice. Evaluate this student session.\nScenario: ${scenario?.department} / difficulty ${scenario?.difficulty}/10\nLevel: ${student?.level || 'Functional'}\n\nConversation:\n${hist}\n\nRespond ONLY with valid JSON (no markdown):\n{"overall_score":0-100,"connectors_used":[],"connectors_missed":[],"best_moment":"","main_improvement":"","alice_message":""}` }]
      });
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      try {
        return res.json({ evaluation: JSON.parse(text.replace(/```json|```/g, '').trim()) });
      } catch(e) {
        return res.json({ evaluation: { overall_score: 70, alice_message: text, connectors_used: [], connectors_missed: [], best_moment: '', main_improvement: '' } });
      }
    }

    // chat mode
    const ctx = `Student: ${student?.name || 'Student'} | Level: ${student?.level || 'Functional'} | Sessions: ${student?.sessionsCompleted || 0} | Weak areas: ${(student?.weakAreas || []).join(', ') || 'none'}
Scenario: ${scenario ? `${scenario.department} / ${scenario.case_type} / Customer: ${scenario.customer_personality} / Difficulty ${scenario.difficulty}/10` : 'free practice'}`;

    const msgs = history && history.length > 0
      ? [...history.slice(-14), { role: 'user', content: message }]
      : [{ role: 'user', content: `[CONTEXT: ${ctx}]\n\nScenario start. Student says: ${message}` }];

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 350,
      system: ALICE_SYSTEM, messages: msgs
    });
    res.json({ reply: resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n') });

  } catch (err) {
    console.error('Alice error:', err);
    res.status(500).json({ error: 'Alice no está disponible ahora.' });
  }
});

// ── ANALYZE — KPI Tracker IA ────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { prompt, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ text: resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n') });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Error al analizar' });
  }
});

// ── HEALTHCHECK ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('Alice by Studio Infinity CR — OK'));

app.listen(PORT, () => console.log(`Alice server running on port ${PORT}`));
