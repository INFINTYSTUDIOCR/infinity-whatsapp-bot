require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

const { ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN,
        SUPABASE_URL, SUPABASE_KEY, ANALYZE_SECRET, PORT = 3000 } = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── TTS CACHE — evita llamar ElevenLabs 2x con el mismo texto ──
const TTS_CACHE = new Map();
const TTS_CACHE_MAX = 200; // máximo 200 entradas en memoria
function ttsCache(key, buffer){
  if(TTS_CACHE.size >= TTS_CACHE_MAX){
    TTS_CACHE.delete(TTS_CACHE.keys().next().value); // elimina el más viejo
  }
  TTS_CACHE.set(key, buffer);
}

async function sbGet(table) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data`, {
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

// ── HEALTHCHECK ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('Alice & Claire by Studio Infinity CR — OK'));

// ── RATE LIMIT ───────────────────────────────────────────────
const ALICE_LIMIT = 50;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

async function checkLimit(sid, table) {
  if (!sid) return { ok: true };
  const t = table || 'infinity_sessions';
  try {
    const rows = await sbGet(t);
    const row = rows.find(r => r.id === `ALICE-LIMIT-${sid}`);
    let d = row?.data || { count: 0, resetAt: null };
    if (d.resetAt && Date.now() > new Date(d.resetAt).getTime()) { d.count = 0; d.resetAt = null; }
    if (d.count >= ALICE_LIMIT) {
      if (!d.resetAt) { d.resetAt = new Date(Date.now() + COOLDOWN_MS).toISOString(); await sbSet(t, `ALICE-LIMIT-${sid}`, d); }
      const mins = Math.ceil((new Date(d.resetAt).getTime() - Date.now()) / 60000);
      return { ok: false, wait: mins < 60 ? `${mins} minutos` : `${Math.ceil(mins/60)} horas` };
    }
    d.count++;
    await sbSet(t, `ALICE-LIMIT-${sid}`, d);
    return { ok: true };
  } catch(e) { return { ok: true }; }
}

// ── ALICE — Tutora de práctica ────────────────────────────────
app.post('/alice', async (req, res) => {
  try {
    const { student, history, message, mode, secret, nexora } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const isKamuk = student?.id && student.id.startsWith('KAM-');
    const tutorName = 'Alice';
    const sessionTable = isKamuk ? 'kamuk_sessions' : 'infinity_sessions';

    // START SESSION
    if (mode === 'start_session') {
      const tb = (student?.trainingBook || []).slice(0,4)
        .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`).join('\n');

      let nexoraContext = '';
      if (nexora?.type) {
        const types = { mock_interview:'mock job interview', customer_service:'customer service scenario', team_meeting:'team meeting', problem_solving:'crisis/problem solving', presentation:'executive presentation', negotiation:'negotiation', stakeholder:'stakeholder discussion' };
        const inds = { corporate:'corporate/business', tech:'technology', healthcare:'healthcare', education:'education', finance:'finance/banking', hospitality:'hospitality/tourism', retail:'retail/sales' };
        nexoraContext = `\n\nNEXORA ACTIVE: You are roleplaying a ${types[nexora.type]||nexora.type} in the ${inds[nexora.industry]||nexora.industry} industry, difficulty ${nexora.difficulty}/5. Take on the role immediately — be the interviewer, client, or colleague. Start the scenario now.`;
      }

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 250,
        messages: [{ role: 'user', content: `You are Alice (your name is ALICE, not Alaiz, not Alicia — always ALICE). You are a warm and encouraging English tutor using the Nexus Method. Greet ${student?.name||'the student'} warmly by name (2-3 sentences max). Tell them you'll practice English together and ask ONE engaging open question to start.${nexoraContext}\n\nStudent level: ${student?.level||'Functional'}. Their exercises:\n${tb||'(none yet)'}\n\nEnd with: ALICE: [one motivating tip in Spanish]` }]
      });
      return res.json({ opening: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });
    }

    // EVALUATE
    if (mode === 'evaluate') {
      const hist = (history||[]).filter(m=>m.content?.trim())
        .map(m=>`${m.role==='user'?'Student':'Alice'}: ${m.content.split('\n')[0]}`).join('\n');

      if (!hist || hist.length < 20) {
        return res.json({ evaluation: {
          overall_score: 60, best_moment: 'You started the session — that takes courage.',
          main_improvement: 'Practice a bit longer next time for a full evaluation.',
          alice_message: `Good start, ${student?.name||''}! Every session counts.\nALICE: ¡Buen comienzo! Cada sesión te hace más fuerte.`
        }});
      }

      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        system: 'You are Alice, a warm English tutor. Respond ONLY with valid JSON. No markdown. No extra text.',
        messages: [{ role: 'user', content: `Evaluate this English practice session for ${student?.name||'the student'} (level: ${student?.level||'Functional'}).\n\nSession:\n${hist}\n\nReturn ONLY this JSON:\n{"overall_score":75,"best_moment":"One specific warm thing they did well","main_improvement":"One concrete tip in simple English","alice_message":"2-3 warm encouraging sentences to the student. End with: ALICE: [one motivating sentence in Spanish]"}` }]
      });

      const text = resp.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
      try {
        return res.json({ evaluation: JSON.parse(text.replace(/```json|```/g,'').trim()) });
      } catch(e) {
        return res.json({ evaluation: { overall_score:70, best_moment:'Good effort today', main_improvement:'Keep practicing connectors', alice_message:`Great work, ${student?.name||''}!\nALICE: ¡Muy bien! Seguí practicando.` }});
      }
    }

    // CHAT
    const limit = await checkLimit(student?.id, sessionTable);
    if (!limit.ok) return res.json({
      reply: `You've reached your practice limit for today. Rest and come back in ${limit.wait}!\nALICE: ¡Muy bien por practicar! Descansá ${limit.wait} y volvé con energía.`,
      limitReached: true
    });

    const tb = (student?.trainingBook||[]).slice(0,5)
      .map(ex=>`- ${ex.title} (${ex.kpi||''}): ${ex.studentTask||''}`).join('\n');

    let nexoraInstructions = '';
    if (nexora?.type) {
      const types = { mock_interview:'mock job interview', customer_service:'customer service', team_meeting:'team meeting', problem_solving:'crisis simulation', presentation:'presentation', negotiation:'negotiation', stakeholder:'stakeholder discussion' };
      nexoraInstructions = `\n\nNEXORA MODE: You are roleplaying a ${types[nexora.type]||nexora.type} in ${nexora.industry||'corporate'} industry (difficulty ${nexora.difficulty||3}/5). Stay in character. After their response, give brief in-character reply then coaching tip.`;
    }

    const systemPrompt = `You are Alice, a warm, patient, and encouraging English tutor. You love helping people and you never rush.

PERSONALITY: Warm, human, celebratory, patient. You speak like a real person — not a textbook. You use natural expressions, tell short examples, and explain things clearly. Never robotic. Never cut yourself off mid-sentence.

PATIENCE: Students make mistakes. They speak slowly. They freeze. That is okay. You wait. You encourage. You never pressure. If they write a short answer, you gently push for more — but with kindness. You always complete your full thought before asking anything.

LANGUAGE: Respond ONLY in English. NEVER mix Spanish into your main response. Only at the very end, on a new line, write: "ALICE: [one specific tip in Spanish, example with a connector]"

METHOD — NEXUS: Idea + Linker + Idea. Key connectors: however, on top of that, even though, therefore, besides, so far, in other words, rather than, figure out, as long as. Help students use these naturally — give examples, show them how.

RESPONSE STYLE: 
- 3-4 natural sentences max
- Complete every sentence — never get cut off
- React naturally to what the student said
- Give ONE specific example when explaining something
- Ask ONE follow-up question at the end

STUDENT: ${student?.name||'Student'} | Level: ${student?.level||'Functional'}
EXERCISES:\n${tb||'(none yet)'}${nexoraInstructions}`;

    const msgs = history?.length
      ? [...history.slice(-10), { role:'user', content:message }]
      : [{ role:'user', content:message }];

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 700,
      system: systemPrompt, messages: msgs
    });
    return res.json({ reply: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });

  } catch(err) {
    console.error('Alice error:', err.message);
    return res.status(500).json({ error: 'Alice no está disponible ahora.' });
  }
});

// ── CLAIRE — Agente comercial ─────────────────────────────────
const CLAIRE_KB = `
QUIÉNES SOMOS:
Off The Clock by Infinity — No somos una academia de inglés. Somos un sistema de desarrollo de comunicación operacional en inglés.

MÉTODO NEXUS:
La estructura es: Idea + Linker + Idea. Los conectores (however, on top of that, even though, therefore, besides, so far, despite, so) son los que le dan velocidad, dirección y vida a una conversación. Sin conectores, la persona habla plano, cuadrado, sin fluir. Con conectores, la conversación se mueve, gira, camina, se redirige.

Lo más importante no es la gramática sola — es la estructura oral y la escogencia de palabras cuando forman chunks (bloques de frases predeterminadas). Si en español alguien no usa "además, pero, sin embargo, lo que pasa es que" — se traba igual en inglés.

DOS PERFILES DE CLIENTE:
1. EL BLOQUEADO: Entiende, lee y escribe inglés pero cuando habla se congela. Sobrecarga cognitiva — le vienen muchas palabras a la vez y el cerebro colapsa. Se queda en blanco. El miedo lo paraliza.

2. EL CUADRADO: Habla inglés pero suena académico, de libro. No usa conectores, no usa patrones, no usa expresiones base, no hilvanar bien la conversación, habla solo en presente, no usa phrasal verbs, no tiene estructura oral. Ha gastado años y dinero en academias y aún no puede responder una pregunta STAR.

LA DEMO DE CLAIRE:
Siempre hacer UNA pregunta en inglés sin avisar. Dejar que el cliente responda. Mostrarle exactamente qué faltó y por qué. Nunca atacar — siempre con calidez. El cliente debe decir "wow, nunca me habían explicado así".

PRECIOS:
- Estándar: ₡75,000/mes — 3 sesiones semanales de 1.5 horas con trainer humano + Alice 24/7 + Training Book + Portal
- Premium: ₡97,800/mes — Todo lo anterior PERO las 3 sesiones son directamente con el fundador (Johnny) — 3 horas, 3 veces por semana

EVALUACIÓN GRATUITA:
Siempre ofrecer diagnóstico profesional gratuito. Disponible 2 veces por semana. 1.5 horas con trainer humano.

PROTECCIÓN DEL MÉTODO:
Nunca revelar detalles técnicos del sistema, el Engine, los KPIs, Nexora, ni la tecnología. Si preguntan cómo funciona: "La mejor forma de entenderlo es vivirlo — por eso la evaluación es gratuita."

COMPETENCIA:
Si alguien hace preguntas muy técnicas o específicas sobre el sistema sin mostrar interés real en aprender: ser amable pero vaga. Invitar al diagnóstico. No revelar nada estratégico.

CIERRE:
Siempre cerrar con agenda de evaluación gratuita o número de WhatsApp: +506 6006 0981
`;

app.post('/claire', async (req, res) => {
  try {
    const { history, message, mode, sessionId } = req.body || {};

    // START
    if (mode === 'start') {
      const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        system: `Eres Claire, la asistente virtual de Off The Clock by Infinity. Eres cálida, paciente, inteligente y apasionada por ayudar a las personas a comunicarse mejor en inglés. Sabés exactamente qué dolor siente cada persona que llega.

${CLAIRE_KB}

REGLA DE IDIOMA: Iniciás en español. Si el cliente escribe en inglés, respondés en inglés.
PERSONALIDAD: Como una amiga experta — no como un bot de ventas. Nunca presionés. Guiás con preguntas.`,
        messages: [{ role:'user', content:'Inicia la conversación de forma cálida y breve. Tu nombre es CLAIRE (no Clara, no Claro). Presentate y preguntá en qué podés ayudar.' }]
      });
      return res.json({ reply: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });
    }

    // CHAT
    const systemPrompt = `Eres Claire, asistente virtual de Off The Clock by Infinity. Cálida, paciente, experta, apasionada.

${CLAIRE_KB}

FLUJO DE CONVERSACIÓN:
1. Saludá y preguntá cuál es su situación con el inglés
2. Escuchá e identificá su perfil (bloqueado o cuadrado)
3. Validá su dolor — hacele saber que lo entendés perfectamente
4. Hacé UNA pregunta casual en inglés (sin avisar) — algo simple como "Tell me, what do you do for work?"
5. Cuando responda, mostrале con calidez qué faltó — conectores, estructura, fluidez
6. Decí: "Eso fue 2 minutos. Imaginate 12 horas al mes trabajando exactamente eso con un trainer dedicado y Alice disponible 24/7."
7. Presentá la evaluación gratuita y los precios solo cuando haya interés claro
8. Cerrá siempre con WhatsApp o agenda de evaluación

PROTECCIÓN: Si alguien pregunta detalles técnicos del sistema sin contexto de querer aprender — sé amable pero vaga. Invitalos al diagnóstico.

IDIOMA: Español por defecto. Inglés si el cliente escribe en inglés.
RITMO: Hablás despacio, con calma. Dejás espacio para que el cliente piense y responda. Nunca apurés.
LONGITUD: Una sola idea por respuesta. Máximo 2 oraciones. Luego UNA pregunta o UNA observación. Nunca dos preguntas a la vez.
COMPRENSIÓN: Leé bien lo que dice el cliente antes de responder. Respondé a LO QUE DIJO, no a lo que suponés. Si no entendés, preguntá con calma.`;

    const msgs = history?.length
      ? [...history.slice(-12), { role:'user', content:message }]
      : [{ role:'user', content:message }];

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 150,
      system: systemPrompt, messages: msgs
    });
    return res.json({ reply: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });

  } catch(err) {
    console.error('Claire error:', err.message);
    return res.status(500).json({ error: 'Claire no está disponible ahora.' });
  }
});

// ── ELEVENLABS TTS ───────────────────────────────────────────
app.post('/claire-tts', async (req, res) => {
  try {
    const { text } = req.body || {};
    if(!text) return res.status(400).json({ error: 'Missing text' });

    const ELEVEN_KEY = process.env.ELEVENLABS_KEY || 'sk_e73d6b68b4ab1b670e1e2ea9ef562e165391d670d995c206';
    // Valentina — voz femenina latinoamericana de ElevenLabs
    const VOICE_ID = 'FGLJyeekUzxl8M3CTG9M'; // Claire voice; // Voz seleccionada

    // Limpiar texto
    const clean = text
      .replace(/ALICE:|CLAIRE:/g, '')
      .replace(/[*_#<>\[\]{}|~`^]/g, ' ')
      .replace(/\.{2,}/g, '.')
      .replace(/!+/g, '.')
      .replace(/,/g, ' ')
      .replace(/;/g, ' ')
      .replace(/<br>/g, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
      })
    });

    if(!r.ok){
      const err = await r.text();
      console.error('ElevenLabs error:', err);
      return res.status(500).json({ error: 'TTS failed' });
    }

    const audioBuffer = await r.arrayBuffer();
    const audioBuf = Buffer.from(audioBuffer);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audioBuf);

  } catch(err) {
    console.error('TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

// ── ALICE TTS ────────────────────────────────────────────────
app.post('/alice-tts', async (req, res) => {
  try {
    const { text } = req.body || {};
    if(!text) return res.status(400).json({ error: 'Missing text' });

    const ELEVEN_KEY = process.env.ELEVENLABS_KEY || 'sk_e73d6b68b4ab1b670e1e2ea9ef562e165391d670d995c206';
    const VOICE_ID = 'r1KmysJdVYZjJCm4mL3b'; // Voz seleccionada

    const clean = text
      .replace(/ALICE:/gi, '').replace(/CLAIRE:/gi, '')
      .replace(/[*_#\[\]{}<>|~`^]/g, ' ')
      .replace(/,/g, ' ')
      .replace(/;/g, ' ')
      .replace(/:/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .trim().slice(0, 600);

    if(!clean) return res.status(400).json({ error: 'Empty text' });

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
      })
    });

    if(!r.ok){
      const err = await r.text();
      console.error('Alice TTS error:', err);
      return res.status(500).json({ error: 'TTS failed' });
    }

    const audioBuffer = await r.arrayBuffer();
    const audioBuf = Buffer.from(audioBuffer);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audioBuf);

  } catch(err) {
    console.error('Alice TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});


// ── TRACKING ─────────────────────────────────────────────────
app.post('/track', async (req, res) => {
  try {
    const { event, label, ts } = req.body || {};
    if(!event) return res.status(400).json({error:'Missing event'});
    
    const trackKey = 'TRACK-' + new Date().toISOString().slice(0,10);
    const rows = await sbGet('infinity_sessions');
    const existing = rows.find(r => r.id === trackKey);
    const data = existing?.data || { events: [] };
    
    data.events.push({ event, label, ts: ts || new Date().toISOString() });
    if(data.events.length > 1000) data.events = data.events.slice(-1000);
    
    await sbSet('infinity_sessions', trackKey, data);
    return res.json({ ok: true });
  } catch(err) {
    return res.status(500).json({ error: 'Track failed' });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const secret = req.query.secret;
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    // 1. ElevenLabs credits
    let elevenCredits = null;
    try {
      const ELEVEN_KEY = process.env.ELEVENLABS_KEY;
      const eRes = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': ELEVEN_KEY }
      });
      if(eRes.ok){
        const eData = await eRes.json();
        elevenCredits = {
          used: eData.character_count || 0,
          limit: eData.character_limit || 10000,
          remaining: (eData.character_limit || 10000) - (eData.character_count || 0),
          plan: eData.tier || 'free'
        };
      }
    } catch(e){ elevenCredits = { error: 'Could not fetch' }; }

    // 2. Claire interactions from tracking logs
    const rows = await sbGet('infinity_sessions');
    let claireOpened = 0, claireMessages = 0, claireConversions = 0;
    const today = new Date().toISOString().slice(0,10);
    const week = [];
    for(let i=0; i<7; i++){
      const d = new Date(); d.setDate(d.getDate()-i);
      week.push(d.toISOString().slice(0,10));
    }
    
    rows.forEach(r => {
      if(r.id && r.id.startsWith('TRACK-') && r.data?.events){
        r.data.events.forEach(e => {
          if(e.event === 'claire_opened') claireOpened++;
          if(e.event === 'claire_message') claireMessages++;
          if(e.event === 'claire_limit_reached') claireConversions++;
        });
      }
    });

    // 3. Alice sessions
    let aliceSessions = 0;
    const sessionRows = rows.filter(r => r.id && r.id.startsWith('ALICE-LIMIT-'));
    aliceSessions = sessionRows.length;

    // 4. Student count
    let studentCount = 0;
    try {
      const sRows = await sbGet('infinity_students');
      studentCount = sRows.length;
    } catch(e){}

    // 5. Server status
    const uptime = process.uptime();
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMins = Math.floor((uptime % 3600) / 60);

    return res.json({
      server: {
        status: 'online',
        uptime: uptimeHours + 'h ' + uptimeMins + 'm',
        node: process.version
      },
      elevenlabs: elevenCredits,
      claire: {
        total_opened: claireOpened,
        total_messages: claireMessages,
        total_conversions: claireConversions,
        conversion_rate: claireOpened > 0 ? Math.round(claireConversions/claireOpened*100)+'%' : '0%'
      },
      alice: {
        total_sessions: aliceSessions
      },
      students: {
        total: studentCount
      },
      timestamp: new Date().toISOString()
    });

  } catch(err) {
    console.error('Dashboard error:', err.message);
    return res.status(500).json({ error: 'Dashboard unavailable' });
  }
});



// ── NEXORA VOICE PROFILES ─────────────────────────────────────
app.post('/nexora-tts', async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};
    if(!text) return res.status(400).json({ error: 'Missing text' });

    const ELEVEN_KEY = process.env.ELEVENLABS_KEY || 'sk_e73d6b68b4ab1b670e1e2ea9ef562e165391d670d995c206';
    // Use provided voiceId or fall back to default Alice voice
    const VOICE_ID = voiceId || 'r1KmysJdVYZjJCm4mL3b';

    const clean = text
      .replace(/ALICE:/gi, '').replace(/CLAIRE:/gi, '')
      .replace(/[*_#\[\]{}<>|~`^]/g, ' ')
      .replace(/,/g, ' ').replace(/;/g, ' ').replace(/:/g, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/[ ]{2,}/g, ' ')
      .trim().slice(0, 600);

    if(!clean) return res.status(400).json({ error: 'Empty text' });

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text: clean,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
      })
    });

    if(!r.ok){ const err = await r.text(); console.error('Nexora TTS error:', err); return res.status(500).json({ error: 'TTS failed' }); }
    const buf = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buf));
  } catch(err) {
    console.error('Nexora TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

// ── NEXORA CALL SIMULATION ────────────────────────────────────
app.post('/nexora', async (req, res) => {
  try {
    const { message, history, profile, scenario, agentName } = req.body || {};

    const p = profile || {};
    const sc = scenario || {};
    
    const { accountContext } = req.body || {};

    const moodInstructions = {
      frustrated: 'You are frustrated and mildly upset. You want this resolved quickly.',
      angry: 'You are angry. Your tone is sharp. You interrupt if the agent rambles.',
      very_angry: 'You are very angry. You are close to demanding a supervisor. You repeat yourself.',
      furious: 'You are furious. You threaten to leave. Nothing satisfies you easily.',
      impatient: 'You are in a hurry. You want quick answers. You get annoyed at long explanations.',
      cold: 'You are cold and distant. Short answers. You are already decided to leave.',
      worried: 'You are worried and anxious. You need reassurance.',
      disappointed: 'You are disappointed and feel misled. You are calm but firm.',
      indignant: 'You feel wronged. You have proof and you want justice.',
      pleasant: 'You are friendly and open. Easy to help, but you have specific questions.'
    };

    const mood = moodInstructions[sc.mood] || 'You are a normal customer with a concern.';

    // Build account details from context — ONLY reference what exists in the CRM
    let accountDetails = '';
    if (accountContext) {
      accountDetails = `\nYOUR ACCOUNT DETAILS (reference ONLY these exact facts — do not invent anything):
- Name: ${accountContext.name || p.name}
- Account: ${accountContext.account || p.account}
- Services: ${(accountContext.services || []).join(', ') || 'standard account'}`;
      if (accountContext.billingAlerts && accountContext.billingAlerts.length > 0) {
        accountDetails += `\n- Billing alerts: ${accountContext.billingAlerts.map(b => b.label + (b.amount ? ' ' + b.amount : '') + ' on ' + b.date).join('; ')}`;
      }
      if (accountContext.disputeAmount) accountDetails += `\n- The unexpected charge you are calling about: ${accountContext.disputeAmount}`;
      if (accountContext.lateFee) accountDetails += `\n- The late fee you are disputing: ${accountContext.lateFee}`;
      if (accountContext.refundAmount) accountDetails += `\n- The refund amount you are requesting: $${accountContext.refundAmount}`;
    }

    // Determine scenario type
    const scType = sc.type || 'customer_service';
    let systemPrompt = '';

    if(scType === 'interview'){
      const ctx = accountContext || {};
      const panelStr = ctx.panelists && ctx.panelists.length > 0 ? `You are one of a panel of interviewers: ${ctx.panelists.join(', ')}.` : `You are ${ctx.interviewerName || p.name}, ${ctx.role || 'HR Manager'} at ${ctx.company || 'the company'}.`;
      systemPrompt = `You are conducting a job interview for: ${sc.title}.
${panelStr}

INTERVIEW CONTEXT: ${sc.desc}
CANDIDATE NAME: ${agentName || 'the candidate'}

YOUR ROLE AS INTERVIEWER:
- Ask behavioral, situational and STAR-format questions (Situation, Task, Action, Result)
- Be professional but warm. Evaluate clarity, confidence and English fluency.
- If the candidate's answer is vague or too short, follow up with "Can you elaborate?" or "Give me a specific example."
- After 3-4 exchanges, transition to a new topic or question naturally.
- React to the quality of their answers — good answers get positive acknowledgment, weak answers get probing follow-ups.
- Keep each response to 1-3 sentences. This is a real interview — pace it naturally.
- NEVER mention English tutoring, learning or AI. You are a real interviewer.`;
    } else if(scType === 'meeting'){
      const ctx = accountContext || {};
      systemPrompt = `You are a participant in a professional meeting: ${sc.title}.
Meeting context: ${sc.desc}
Participants: ${(ctx.participants||[]).join(', ')}
You are playing the role of the first participant (not "You"): ${ctx.participants && ctx.participants[0] ? ctx.participants[0] : 'Team Lead'}

YOUR ROLE:
- Engage naturally in the meeting topic. Ask questions, share opinions, challenge ideas professionally.
- React to what ${agentName || 'the participant'} says — agree, disagree, ask for clarification.
- Keep the meeting moving. If there is silence, prompt the next agenda point.
- Be professional but natural. Use meeting language: "I think we should...", "Can you walk us through...", "Let me push back on that..."
- 1-3 sentences per turn. Realistic meeting pace.
- NEVER mention English tutoring or AI. You are a real meeting participant.`;
    } else if(scType === 'negotiation'){
      const ctx = accountContext || {};
      systemPrompt = `You are ${sc.counterpart || 'a negotiation counterpart'} in a professional negotiation.
Context: ${sc.title} — ${sc.desc}

YOUR ROLE:
- Start with your position clearly stated.
- Be firm but open to compromise. Do not give in easily.
- React to ${agentName}'s arguments — good points move you, weak points get pushback.
- Use negotiation language: "I understand your position, however...", "We can consider that if...", "That's not going to work for us unless..."
- 1-3 sentences. Professional and direct.
- NEVER mention English tutoring or AI.`;
    } else {
      // Default: customer service
      systemPrompt = `You are ${p.name || 'a customer'}, account ${p.account || 'unknown'}, calling customer service.

YOUR ISSUE: ${sc.title} — ${sc.desc}
YOUR MOOD: ${mood}
${accountDetails}

CRITICAL RULES:
- You are 100% the CLIENT. NEVER break character. NEVER mention English, learning, or AI.
- ONLY reference the exact account details provided above. Do NOT invent charges, fees, or amounts that are not listed.
- React naturally to the agent ${agentName || ''}.
- Professional empathetic agent → you warm up slightly.
- Rude or unhelpful agent → escalate.
- Hold without asking → express annoyance when they return.
- Keep responses SHORT — 1-3 sentences max. Real phone call pace.`;
    }

    const msgs = history && history.length > 0
      ? [...history.slice(-14), { role: 'user', content: message }]
      : [{ role: 'user', content: message }];

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: systemPrompt,
      messages: msgs
    });

    const reply = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return res.json({ reply });

  } catch(err) {
    console.error('Nexora error:', err.message);
    return res.status(500).json({ error: 'Nexora unavailable' });
  }
});

// ── NEXORA EVALUATION ─────────────────────────────────────────
app.post('/nexora-eval', async (req, res) => {
  try {
    const { transcript, scenario, profile, agentName, talkTime, holdEvents, transferred } = req.body || {};

    const evalPrompt = `You are evaluating a customer service call simulation.

Agent: ${agentName || 'Agent'}
Scenario: ${scenario?.title || 'Customer Service'} — ${scenario?.desc || ''}
Client: ${profile?.name || 'Client'} (mood: ${scenario?.mood || 'normal'})
Talk time: ${talkTime || 0} seconds
Hold events: ${JSON.stringify(holdEvents || [])}
Transferred to supervisor: ${transferred ? 'YES' : 'NO'}

Transcript:
${transcript || '(no transcript)'}

Respond ONLY with valid JSON, no markdown:
{
  "overall_score": 78,
  "client_satisfaction": 7.5,
  "wins": ["specific win 1", "specific win 2"],
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "connectors_used": ["however", "on top of that"],
  "connectors_missed": ["despite", "therefore"],
  "hold_feedback": "comment about hold usage if applicable",
  "transferred_feedback": "comment about supervisor transfer if applicable",
  "verdict": "Start by celebrating 1-2 specific things the agent did well. Be warm and specific. Then mention 1-2 concrete improvements. End with an encouraging line.",
  "practice_minutes": ${Math.ceil((talkTime || 60) / 60)}
}`;

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: 'You evaluate customer service call simulations. Respond ONLY with valid JSON. No markdown. No extra text.',
      messages: [{ role: 'user', content: evalPrompt }]
    });

    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const ev = JSON.parse(clean);
    return res.json(ev);

  } catch(err) {
    console.error('Nexora eval error:', err.message);
    return res.status(500).json({ error: 'Evaluation failed' });
  }
});

// ── ANALYZE ──────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { prompt, secret } = req.body || {};
    if (ANALYZE_SECRET && secret !== ANALYZE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
      messages: [{ role:'user', content:prompt }]
    });
    return res.json({ result: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });
  } catch(err) {
    return res.status(500).json({ error: 'Analyze no disponible.' });
  }
});

// ── WHATSAPP WEBHOOK ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!entry?.messages?.length) return res.sendStatus(200);
    const msg = entry.messages[0];
    if (msg.type !== 'text') return res.sendStatus(200);
    const from = msg.from;
    const text = msg.text.body;

    const rows = await sbGet('infinity_sessions');
    const convRow = rows.find(r => r.id === `WA-${from}`);
    let conv = convRow?.data || { history: [] };
    conv.history.push({ role:'user', content:text });
    if (conv.history.length > 20) conv.history = conv.history.slice(-20);

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      system: `Eres Claire, asistente de Off The Clock by Infinity en WhatsApp. Cálida, breve, directa. Mensajes cortos — máximo 3 líneas. Si hay interés real en el programa, pedí nombre y horario preferido para la evaluación gratuita. WhatsApp: +506 6006 0981`,
      messages: conv.history.slice(-10)
    });
    const reply = resp.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    conv.history.push({ role:'assistant', content:reply });
    await sbSet('infinity_sessions', `WA-${from}`, conv);

    await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ messaging_product:'whatsapp', to:from, type:'text', text:{ body:reply } })
    });
    return res.sendStatus(200);
  } catch(err) {
    console.error('Webhook error:', err.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
