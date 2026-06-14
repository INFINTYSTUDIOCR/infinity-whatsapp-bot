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

async function checkLimit(sid) {
  if (!sid) return { ok: true };
  try {
    const rows = await sbGet('infinity_sessions');
    const row = rows.find(r => r.id === `ALICE-LIMIT-${sid}`);
    let d = row?.data || { count: 0, resetAt: null };
    if (d.resetAt && Date.now() > new Date(d.resetAt).getTime()) { d.count = 0; d.resetAt = null; }
    if (d.count >= ALICE_LIMIT) {
      if (!d.resetAt) { d.resetAt = new Date(Date.now() + COOLDOWN_MS).toISOString(); await sbSet('infinity_sessions', `ALICE-LIMIT-${sid}`, d); }
      const mins = Math.ceil((new Date(d.resetAt).getTime() - Date.now()) / 60000);
      return { ok: false, wait: `${Math.floor(mins/60)}h ${mins%60}min` };
    }
    d.count++;
    await sbSet('infinity_sessions', `ALICE-LIMIT-${sid}`, d);
    return { ok: true };
  } catch(e) { return { ok: true }; }
}

// ── ALICE ENDPOINT ───────────────────────────────────────────
app.post('/alice', async (req, res) => {
  try {
    const { student, scenario, history, message, mode, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    // start_session — saludo inicial como tutora
    if (mode === 'start_session') {
      const tb = (student?.trainingBook || []).slice(0,4)
        .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`)
        .join('\n');
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are Alice, English tutor at Studio Infinity CR. Greet the student warmly in English (2-3 sentences). Tell them your name, that you will practice English together using the Nexus Method (Idea + Linker + Idea), and ask ONE open question to start. Student: ${student?.name || 'Student'}, Level: ${student?.level || 'Functional'}. Their exercises: ${tb || 'none yet'}.`
        }]
      });
      const opening = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return res.json({ opening });
    }

    // evaluate
    if (mode === 'evaluate') {
      const hist = (history || []).map(m => `${m.role === 'user' ? 'Student' : 'Alice'}: ${m.content}`).join('\n');
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Evaluate this English tutoring session. Student level: ${student?.level || 'Functional'}.\n\nConversation:\n${hist}\n\nRespond ONLY with this exact JSON (no markdown, no extra text):\n{"overall_score":75,"connectors_used":["however"],"connectors_missed":["on top of that"],"best_moment":"good attempt","main_improvement":"use more connectors","alice_message":"Great effort! Keep practicing."}`
        }]
      });
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        return res.json({ evaluation: JSON.parse(clean) });
      } catch(e) {
        return res.json({ evaluation: { overall_score: 70, connectors_used: [], connectors_missed: [], best_moment: '', main_improvement: '', alice_message: text } });
      }
    }

    // chat — rate limit
    const limit = await checkLimit(student?.id);
    if (!limit.ok) {
      return res.json({
        reply: `Great effort today! You've reached your practice limit. Rest for ${limit.wait} and come back stronger.\nALICE: Muy bien por practicar! Descansá ${limit.wait} y volvé con energía.`,
        limitReached: true
      });
    }

    // chat — tutora de inglés pura
    const tb = (student?.trainingBook || []).slice(0, 5)
      .map(ex => `- ${ex.title} (${ex.kpi || ''}): ${ex.studentTask || ''}`)
      .join('\n');

    const systemPrompt = `You are Alice, English tutor at Studio Infinity CR — Nexus Method.

LANGUAGE RULE: Respond in English ONLY. The ONLY Spanish allowed is the final line starting with "ALICE:".

YOUR JOB: Practice natural English conversation. Ask open questions about their life, work, opinions. Push them to use connectors. Never accept one-word answers.

NEXUS METHOD: Fluency = Idea + Linker + Idea. Linkers: however, on top of that, even though, as well as, therefore, besides, so far, in other words, rather than, figure out.

STUDENT: ${student?.name || 'Student'} | Level: ${student?.level || 'Functional'} | Sessions: ${student?.sessionsCompleted || 0}
EXERCISES ASSIGNED:\n${tb || '(none yet)'}

RESPONSE FORMAT (follow exactly):
[2-4 sentences in English. React to what they said, push for more, suggest a connector.]
ALICE: [1-2 sentences in Spanish telling them exactly what to say next with the connector. Example: "Bien! Usá 'however' — decí: I like my job, however the schedule is tough."]`;

    const msgs = history && history.length > 0
      ? [...history.slice(-12), { role: 'user', content: message }]
      : [{ role: 'user', content: message }];

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: msgs
    });

    const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.json({ reply });

  } catch (err) {
    console.error('Alice error:', err.message);
    return res.status(500).json({ error: 'Alice no está disponible ahora.' });
  }
});

// ── ANALYZE ──────────────────────────────────────────────────
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
    res.status(500).json({ error: 'Error al analizar' });
  }
});

// ── WHATSAPP ─────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
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
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      system: 'Sos el asistente de Studio Infinity CR. Respondé en español, mensajes cortos. Si hay interés real en clases de inglés, pedí nombre y programa (Individual/Corporate/Institutional).',
      messages: convo.messages.slice(-10)
    });
    const replyText = response.content.filter(b => b.type === 'text').map(b => b.text).join('') || 'Gracias por tu mensaje.';
    convo.messages.push({ role: 'assistant', content: replyText });
    await sbSet('infinity_sessions', `CHAT-${phone}`, convo);
    await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: replyText } })
    });
  } catch (err) { console.error('WhatsApp error:', err.message); }
});

app.listen(PORT, () => console.log(`Alice server running on port ${PORT}`));
