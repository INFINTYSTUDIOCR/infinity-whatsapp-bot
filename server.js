require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

const { ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN,
        SUPABASE_URL, SUPABASE_KEY, ANALYZE_SECRET, PORT = 3000 } = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function sbGet(table) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=id,data`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) return [];
  return r.json();
}

async function sbSet(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id, data, updated_at: new Date().toISOString() })
  });
  return r.ok;
}

// ── HEALTHCHECK ─────────────────────────────────────────────
app.get('/', (req, res) => res.send('Alice by Studio Infinity CR — OK'));

// ── RATE LIMIT ───────────────────────────────────────────────
const ALICE_LIMIT = 50;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

async function checkLimit(sid, table) {
  if (!sid) return { ok: true };
  const sessionTable = table || 'infinity_sessions';
  try {
    const rows = await sbGet(sessionTable);
    const row = rows.find(r => r.id === `ALICE-LIMIT-${sid}`);
    let d = row?.data || { count: 0, resetAt: null };
    if (d.resetAt && Date.now() > new Date(d.resetAt).getTime()) { d.count = 0; d.resetAt = null; }
    if (d.count >= ALICE_LIMIT) {
      if (!d.resetAt) { d.resetAt = new Date(Date.now() + COOLDOWN_MS).toISOString(); await sbSet(sessionTable, `ALICE-LIMIT-${sid}`, d); }
      const mins = Math.ceil((new Date(d.resetAt).getTime() - Date.now()) / 60000);
      return { ok: false, wait: mins < 60 ? `${mins} minutos` : `${Math.ceil(mins/60)} horas` };
    }
    d.count++;
    await sbSet(sessionTable, `ALICE-LIMIT-${sid}`, d);
    return { ok: true };
  } catch(e) { return { ok: true }; }
}

// ── ALICE / CLAIRE ENDPOINT ───────────────────────────────────
app.post('/alice', async (req, res) => {
  try {
    const { student, history, message, mode, secret, nexora } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const isKamuk = student?.id && student.id.startsWith('KAM-');
    const tutorName = isKamuk ? 'Claire' : 'Alice';
    const sessionTable = isKamuk ? 'kamuk_sessions' : 'infinity_sessions';

    // ── START SESSION ─────────────────────────────────────────
    if (mode === 'start_session') {
      const tb = (student?.trainingBook || []).slice(0,4)
        .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`)
        .join('\n');

      let nexoraContext = '';
      if (nexora && nexora.type) {
        const typeLabels = { mock_interview:'mock job interview', customer_service:'customer service scenario', team_meeting:'team meeting', problem_solving:'crisis/problem solving', presentation:'executive presentation', negotiation:'negotiation', stakeholder:'stakeholder discussion' };
        const indLabels = { corporate:'corporate/business', tech:'technology', healthcare:'healthcare', education:'education', finance:'finance/banking', hospitality:'hospitality/tourism', retail:'retail/sales' };
        nexoraContext = `\n\nNEXORA ACTIVE: Today's session is a ${typeLabels[nexora.type]||nexora.type} simulation in the ${indLabels[nexora.industry]||nexora.industry} industry, difficulty ${nexora.difficulty}/5. Start the simulation immediately — take on the role of the other person (interviewer, client, colleague, etc.) and begin the scenario. Be warm but professional.`;
      }

      const prompt = `You are ${tutorName}, a warm and encouraging English tutor. Greet ${student?.name || 'the student'} by name in a friendly, human way (2-3 sentences max). Tell them you'll practice English together and ask ONE engaging question to start.${nexoraContext}\n\nStudent level: ${student?.level || 'Functional'}. Their exercises: ${tb || 'none assigned yet'}.\n\nEnd with a short Spanish coaching tip on a new line starting with "${tutorName.toUpperCase()}:"`;

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }]
      });
      const opening = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return res.json({ opening });
    }

    // ── EVALUATE ──────────────────────────────────────────────
    if (mode === 'evaluate') {
      const hist = (history || [])
        .filter(m => m.content && m.content.trim())
        .map(m => `${m.role === 'user' ? 'Student' : tutorName}: ${m.content.split('\n')[0]}`)
        .join('\n');

      if (!hist || hist.length < 20) {
        return res.json({ evaluation: {
          overall_score: 60,
          connectors_used: [],
          connectors_missed: ['however', 'on top of that'],
          best_moment: 'Started the session',
          main_improvement: 'Practice longer to get a full evaluation',
          alice_message: `Good start, ${student?.name||''}! Next time, try to practice a bit longer so I can give you a better evaluation. ¡Buen comienzo! La próxima vez practicá un poco más para darte una mejor evaluación.`
        }});
      }

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `You are Alice, a warm English tutor. Respond with ONLY a valid JSON object. No markdown, no explanation, no extra text, no code blocks. ONLY the raw JSON.`,
        messages: [{
          role: 'user',
          content: `You are Alice, a warm English tutor. Evaluate this practice session and return ONLY valid JSON — no markdown, no extra text, nothing else.

Student: ${student?.name||'Student'}, Level: ${student?.level||'Functional'}

Session:
${hist}

Rules for the evaluation:
- overall_score: a number from 0-100
- best_moment: ONE short sentence in simple English saying what the student did well. Warm and specific.
- main_improvement: ONE short sentence in simple English with ONE concrete tip. No jargon.
- alice_message: 2-3 warm, encouraging sentences directly to the student in simple English. Like a human coach, not a report. End with "ALICE: [one motivating sentence in Spanish]"
- Do NOT include: connectors_used, connectors_missed, alice_feedback, pacing_issue, or any technical analysis
- Write as if talking directly to a teenager or young adult student, not to a trainer

Return ONLY this JSON:
{"overall_score":75,"best_moment":"You kept trying even when it was hard","main_improvement":"Next time, try to add one more idea after each answer","alice_message":"You did great today! Every time you speak in English you are getting stronger. Keep going!\nALICE: ¡Muy bien! Cada sesión te hace más fuerte. ¡Seguí adelante!"}`
        }]
      });

      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return res.json({ evaluation: parsed });
      } catch(e) {
        // Si no pudo parsear, construir evaluación básica
        return res.json({ evaluation: {
          overall_score: 70,
          connectors_used: [],
          connectors_missed: [],
          best_moment: 'Good effort in this session',
          main_improvement: 'Keep practicing connectors',
          alice_message: `Great work today, ${student?.name||''}! Keep it up.\nALICE: ¡Muy bien! Seguí practicando.`
        }});
      }
    }

    // ── CHAT ──────────────────────────────────────────────────
    const limit = await checkLimit(student?.id, sessionTable);
    if (!limit.ok) {
      return res.json({
        reply: `Great effort today! You've reached your practice limit. Rest for ${limit.wait} and come back stronger.\n${tutorName.toUpperCase()}: Muy bien por practicar! Descansá ${limit.wait} y volvé con energía.`,
        limitReached: true
      });
    }

    const tb = (student?.trainingBook || []).slice(0, 5)
      .map(ex => `- ${ex.title} (${ex.kpi || ''}): ${ex.studentTask || ''}`)
      .join('\n');

    let nexoraInstructions = '';
    if (nexora && nexora.type) {
      const typeLabels = { mock_interview:'mock job interview', customer_service:'customer service', team_meeting:'team meeting', problem_solving:'crisis simulation', presentation:'presentation practice', negotiation:'negotiation', stakeholder:'stakeholder discussion' };
      nexoraInstructions = `\n\nNEXORA MODE ACTIVE: You are roleplaying a ${typeLabels[nexora.type]||nexora.type} scenario in the ${nexora.industry||'corporate'} industry (difficulty ${nexora.difficulty||3}/5). Stay in character as the interviewer/client/colleague. Push the student to use structured English. After their response, give brief in-character feedback then coaching tip.`;
    }

    const systemPrompt = `You are ${tutorName}, a warm and encouraging English tutor using the Nexus Method.

PERSONALITY: Warm, human, encouraging. Never robotic. React naturally to what the student says. Celebrate wins. Be direct but kind.

LANGUAGE RULE: Respond in English ONLY. End each response with ONE line starting with "${tutorName.toUpperCase()}:" in Spanish — a specific coaching tip with an example sentence using a connector.

NEXUS METHOD: Fluency = Idea + Linker + Idea. Key linkers: however, on top of that, even though, as well as, therefore, besides, so far, in other words, rather than, figure out.

STUDENT: ${student?.name || 'Student'} | Level: ${student?.level || 'Functional'}
ASSIGNED EXERCISES:\n${tb || '(none yet)'}${nexoraInstructions}

RESPONSE FORMAT:
[2-3 natural sentences in English reacting to what they said, asking a follow-up question or pushing for more]
${tutorName.toUpperCase()}: [1 sentence in Spanish with a specific connector example]`;

    const msgs = history && history.length > 0
      ? [...history.slice(-10), { role: 'user', content: message }]
      : [{ role: 'user', content: message }];

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 280,
      system: systemPrompt,
      messages: msgs
    });

    const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.json({ reply });

  } catch (err) {
    console.error('Alice/Claire error:', err.message);
    return res.status(500).json({ error: 'Tutor no disponible ahora.' });
  }
});

// ── ANALYZE ──────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { prompt, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.json({ result: text });
  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: 'Analyze no disponible.' });
  }
});

// ── WHATSAPP WEBHOOK ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages?.length) return res.sendStatus(200);
    const msg = entry.messages[0];
    if (msg.type !== 'text') return res.sendStatus(200);
    const from = msg.from;
    const text = msg.text.body;

    const rows = await sbGet('infinity_sessions');
    const convRow = rows.find(r => r.id === `WA-${from}`);
    let conv = convRow?.data || { history: [], stage: 'greeting' };
    conv.history.push({ role: 'user', content: text });
    if (conv.history.length > 20) conv.history = conv.history.slice(-20);

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'Sos el asistente de Studio Infinity CR. Respondé en español, mensajes cortos. Si hay interés real en clases de inglés, pedí nombre y programa (Individual/Corporate/Institutional).',
      messages: conv.history.slice(-10)
    });
    const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    conv.history.push({ role: 'assistant', content: reply });
    await sbSet('infinity_sessions', `WA-${from}`, conv);

    await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: from, type: 'text', text: { body: reply } })
    });
    return res.sendStatus(200);
  } catch(err) {
    console.error('Webhook error:', err.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
