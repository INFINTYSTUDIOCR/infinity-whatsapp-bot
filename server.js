require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { signToken, verifyToken, requireAuth, optionalAuth, JWT_EXPIRY_SEC, JWT_SECRET } = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// ── SECURITY HEADERS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  next();
});

// ── CORS (allowed origins only) ──────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://infintystudiocr.github.io,https://studioinfinitycr.com,https://www.studioinfinitycr.com,http://localhost:8765,http://127.0.0.1:5500,http://localhost:5500'
).split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o.replace(/\/$/, '')))) {
      return callback(null, true);
    }
    console.warn('CORS blocked:', origin);
    return callback(new Error('CORS not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

if (!JWT_SECRET) {
  console.warn('⚠ JWT_SECRET not set — set JWT_SECRET or ANALYZE_SECRET in Render env for production auth.');
}

const { ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN,
        ANALYZE_SECRET, PORT = 3000 } = process.env;
// Same Supabase project as Student Portal / Engine (Render env overrides when set)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxruvpfdpgowmpvydacd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4cnV2cGZkcGdvd21wdnlkYWNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMzQ4MjAsImV4cCI6MjA5NjcxMDgyMH0.WzwMUnsuZfzkP2QoQzJnnvvgnG-saWkn1IQVDv-_roE';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Raw fetch wrapper — bypasses SDK bug with Render's Node environment
async function claudeCall({ model, max_tokens, system, messages }) {
  const body = { model: model || 'claude-haiku-4-5-20251001', max_tokens: max_tokens || 500, messages };
  if (system) body.system = system;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

async function sbGet(table) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('sbGet: SUPABASE_URL or SUPABASE_KEY not configured');
    return [];
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id,data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error(`sbGet ${table} failed: ${r.status} ${t.slice(0, 120)}`);
      return [];
    }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`sbGet ${table} error:`, err.message);
    return [];
  }
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

// ── KEY DIAGNOSTIC (temp) ────────────────────────────────────
app.get('/keycheck', async (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || '';
  const preview = k ? k.slice(0,12)+'...'+k.slice(-4) : '(NOT SET)';
  // Test via raw fetch (bypasses SDK)
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': k,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user',content:'Say OK'}] })
    });
    const data = await r.json();
    return res.json({ key: preview, status: r.ok ? 'WORKS' : 'API_ERROR', httpStatus: r.status, data });
  } catch(e) {
    return res.json({ key: preview, status: 'NETWORK_FAIL', error: e.message });
  }
});

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

// ── LOGIN RATE LIMIT (brute force) — solo cuenta intentos fallidos ──
const loginRateMap = new Map();
const LOGIN_MAX_ATTEMPTS = 40;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  let entry = loginRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginRateMap.set(ip, entry);
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { ok: false, waitMin: Math.max(1, Math.ceil((entry.resetAt - now) / 60000)) };
  }
  return { ok: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let entry = loginRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  }
  entry.count++;
  loginRateMap.set(ip, entry);
}

function clearLoginRateLimit(ip) {
  loginRateMap.delete(ip);
}

const AUTH_ROLES = ['student', 'trainer', 'superadmin', 'master'];
const requireProductAuth = requireAuth(['student', 'trainer', 'superadmin', 'master']);

function assertStudentScope(req, studentId) {
  if (req.auth.role === 'student' && studentId && studentId !== req.auth.studentId) {
    return false;
  }
  return true;
}

// ── AUTH ─────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { user, password, role } = req.body || {};
    const ip = getClientIp(req);
    const rl = checkLoginRateLimit(ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many login attempts', waitMin: rl.waitMin });
    }
    if (!user || !password || !role) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    if (!JWT_SECRET) {
      return res.status(503).json({ error: 'Auth not configured on server' });
    }

    const loginUser = String(user).trim().toLowerCase();

    if (role === 'student') {
      const rows = await sbGet('infinity_students');
      const match = rows.find(r =>
        r.data &&
        String(r.data.portalUser || '').trim().toLowerCase() === loginUser &&
        r.data.portalPass === password
      );
      if (!match) {
        recordLoginFailure(ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (match.data.status === 'suspended') {
        return res.status(403).json({ error: 'Account suspended' });
      }
      clearLoginRateLimit(ip);
      const token = signToken({
        sub: match.id,
        role: 'student',
        studentId: match.id,
        name: match.data.info?.name || loginUser
      });
      return res.json({
        token,
        expiresIn: JWT_EXPIRY_SEC,
        role: 'student',
        studentId: match.id,
        name: match.data.info?.name || loginUser
      });
    }

    if (role === 'trainer') {
      const masterEmail = (process.env.MASTER_TRAINER_EMAIL || 'trainer@infinity.cr').toLowerCase();
      const masterPass = process.env.MASTER_TRAINER_PASS || process.env.ANALYZE_SECRET || 'nexus2025';
      if (loginUser === masterEmail && password === masterPass) {
        clearLoginRateLimit(ip);
        const token = signToken({
          sub: 'USR-MASTER',
          role: 'superadmin',
          name: process.env.MASTER_TRAINER_NAME || 'Master Trainer',
          email: masterEmail
        });
        return res.json({
          token,
          expiresIn: JWT_EXPIRY_SEC,
          role: 'superadmin',
          name: process.env.MASTER_TRAINER_NAME || 'Master Trainer'
        });
      }
      const rows = await sbGet('infinity_users');
      const match = rows.find(r =>
        r.data &&
        String(r.data.email || '').trim().toLowerCase() === loginUser &&
        r.data.pass === password
      );
      if (!match) {
        recordLoginFailure(ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (match.data.status === 'suspended') {
        return res.status(403).json({ error: 'Account suspended' });
      }
      clearLoginRateLimit(ip);
      const trainerRole = match.data.role || 'trainer';
      const token = signToken({
        sub: match.id,
        role: trainerRole,
        name: match.data.name,
        email: match.data.email,
        department: match.data.department
      });
      return res.json({
        token,
        expiresIn: JWT_EXPIRY_SEC,
        role: trainerRole,
        name: match.data.name
      });
    }

    return res.status(400).json({ error: 'Invalid role' });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

app.get('/auth/verify', requireProductAuth, (req, res) => {
  res.json({
    ok: true,
    role: req.auth.role,
    sub: req.auth.sub,
    name: req.auth.name,
    studentId: req.auth.studentId || null
  });
});

// ── DEMO: IP LIMITS + RESPONSE BUFFER ────────────────────────
const DEMO_LIMITS = {
  alice:  { sessionsPerDay: 5, maxSteps: 4 },
  nexora: { sessionsPerDay: 5, maxSteps: 3 },
  claire: { sessionsPerDay: 8, messagesPerDay: 30 },
  tts:    { sessionsPerDay: 999, messagesPerDay: 40, ttsPerDay: 40 }
};
const IP_DAY_MS = 24 * 60 * 60 * 1000;
const demoResponseCache = new Map();
const DEMO_CACHE_MAX = 300;

let DEMO_BUFFER = {};
try {
  const bufCandidates = [
    path.join(__dirname, '../config/demo-buffer.json'),
    path.join(__dirname, 'config/demo-buffer.json')
  ];
  for (const bufPath of bufCandidates) {
    if (fs.existsSync(bufPath)) {
      DEMO_BUFFER = JSON.parse(fs.readFileSync(bufPath, 'utf8'));
      console.log('demo-buffer loaded:', bufPath);
      break;
    }
  }
  if (!Object.keys(DEMO_BUFFER).length) console.warn('demo-buffer.json not found in config paths');
} catch (e) {
  console.warn('demo-buffer.json not loaded:', e.message);
}

const ELEVEN_KEY = process.env.ELEVENLABS_KEY || '';
const ALICE_VOICE_ID = process.env.ALICE_VOICE_ID || 'r1KmysJdVYZjJCm4mL3b';
const JILL_VOICE_ID = process.env.JILL_VOICE_ID || 'NoOVOzCQFLOvtsMoNcdT';
const CLAIRE_VOICE_ID = process.env.CLAIRE_VOICE_ID || 'FGLJyeekUzxl8M3CTG9M';

function loadVoicesConfig() {
  const candidates = [
    path.join(__dirname, '../config/voices.json'),
    path.join(__dirname, 'config/voices.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { /* next path */ }
  }
  return {};
}

function getDemoVoiceProfiles() {
  const cfg = loadVoicesConfig();
  const nd = cfg.nexora_demo || {};
  const starFromEnv = (process.env.NEXORA_DEMO_MALE_VOICE_ID || '').trim();
  const csFromEnv = (process.env.NEXORA_DEMO_FEMALE_VOICE_ID || '').trim();
  const starFromFile = (nd.star_interviewer?.voiceId || '').trim();
  const csFromFile = (nd.cs_client?.voiceId || JILL_VOICE_ID).trim();
  const starId = starFromEnv || starFromFile || ALICE_VOICE_ID;
  const csId = csFromEnv || csFromFile;
  return {
    alice: {
      voiceId: ALICE_VOICE_ID,
      label: cfg.alice?.label || 'Alice',
      gender: 'female',
      source: 'elevenlabs-account'
    },
    nexora_star: {
      voiceId: starId,
      label: nd.star_interviewer?.label || 'Interviewer',
      gender: 'male',
      source: starFromEnv ? 'NEXORA_DEMO_MALE_VOICE_ID' : (starFromFile ? 'voices.json' : 'alice-fallback'),
      needsMaleVoice: !starFromEnv && !starFromFile
    },
    nexora_cs: {
      voiceId: csId,
      label: nd.cs_client?.label || 'Maria Santos',
      gender: 'female',
      source: csFromEnv ? 'NEXORA_DEMO_FEMALE_VOICE_ID' : 'jill-voices.json'
    }
  };
}

function getDemoTtsAllowlist() {
  const p = getDemoVoiceProfiles();
  const cfg = loadVoicesConfig();
  const nd = cfg.nexora_demo || {};
  return new Set([
    ALICE_VOICE_ID, JILL_VOICE_ID, CLAIRE_VOICE_ID,
    p.nexora_star.voiceId, p.nexora_cs.voiceId,
    nd.star_interviewer?.voiceId,
    nd.cs_client?.voiceId
  ].filter(Boolean));
}

function getDemoVoiceProfileFor(service, scenario) {
  const profiles = getDemoVoiceProfiles();
  if (service === 'alice') return profiles.alice;
  if (service === 'nexora') {
    return scenario === 'customer_service' ? profiles.nexora_cs : profiles.nexora_star;
  }
  return profiles.alice;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function ipStorageKey(ip) {
  return 'DEMO-IP-' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getIpRecord(ip) {
  const id = ipStorageKey(ip);
  try {
    const rows = await sbGet('infinity_sessions');
    const row = rows.find(r => r.id === id);
    return { id, data: row?.data || {} };
  } catch (e) {
    return { id, data: {} };
  }
}

async function saveIpRecord(id, data) {
  try { await sbSet('infinity_sessions', id, data); } catch (e) {}
}

async function checkDemoIpLimit(ip, service, { action } = {}) {
  if (!ip || ip === 'unknown') return { ok: true, sessionsLeft: DEMO_LIMITS[service]?.sessionsPerDay || 5 };
  const limits = DEMO_LIMITS[service];
  if (!limits) return { ok: true };

  const { id, data } = await getIpRecord(ip);
  const day = todayKey();
  const bucket = data[service] || { day, sessions: 0, messages: 0 };
  if (bucket.day !== day) { bucket.day = day; bucket.sessions = 0; bucket.messages = 0; bucket.tts = 0; }

  if (action === 'session') {
    if (bucket.sessions >= limits.sessionsPerDay) {
      return { ok: false, reason: 'sessions', wait: '24 horas', sessionsLeft: 0 };
    }
    bucket.sessions++;
  }

  if (action === 'message') {
    bucket.messages = (bucket.messages || 0) + 1;
    if (limits.messagesPerDay && bucket.messages > limits.messagesPerDay) {
      data[service] = bucket;
      await saveIpRecord(id, data);
      return { ok: false, reason: 'messages', wait: '24 horas', sessionsLeft: 0 };
    }
  }

  if (action === 'tts') {
    bucket.tts = (bucket.tts || 0) + 1;
    const ttsCap = limits.ttsPerDay || limits.messagesPerDay || 40;
    if (bucket.tts > ttsCap) {
      data[service] = bucket;
      await saveIpRecord(id, data);
      return { ok: false, reason: 'tts', wait: '24 horas', sessionsLeft: 0 };
    }
  }

  data[service] = bucket;
  await saveIpRecord(id, data);
  return {
    ok: true,
    sessionsLeft: Math.max(0, limits.sessionsPerDay - bucket.sessions),
    messagesLeft: limits.messagesPerDay ? Math.max(0, limits.messagesPerDay - bucket.messages) : null
  };
}

function bufferKey(service, scenario, step) {
  return service + ':' + (scenario || 'default') + ':' + step;
}

function cacheDemoResponse(key, reply) {
  if (demoResponseCache.size >= DEMO_CACHE_MAX) {
    demoResponseCache.delete(demoResponseCache.keys().next().value);
  }
  demoResponseCache.set(key, reply);
}

function getDemoBuffer(service, scenario) {
  if (service === 'alice') return DEMO_BUFFER.alice;
  if (service === 'nexora') {
    return scenario === 'customer_service' ? DEMO_BUFFER.nexora_cs : DEMO_BUFFER.nexora_star;
  }
  return null;
}

function detectConnectors(text) {
  const list = ['however', 'on top of that', 'even though', 'therefore', 'besides', 'so far', 'in other words', 'despite', 'as a result', 'in addition'];
  const lower = (text || '').toLowerCase();
  return list.filter(c => lower.includes(c));
}

function enrichEvaluation(baseEval, history) {
  const userText = (history || []).filter(m => m.role === 'user').map(m => m.content).join(' ');
  const found = detectConnectors(userText);
  const ev = JSON.parse(JSON.stringify(baseEval));
  if (found.length && ev.connectors_found !== undefined) ev.connectors_found = found;
  if (found.length && ev.connectors_suggested) {
    ev.connectors_suggested = ev.connectors_suggested.filter(c => !found.includes(c));
  }
  if (found.length >= 2 && ev.overall_score) ev.overall_score = Math.min(95, ev.overall_score + 10);
  else if (found.length === 1 && ev.overall_score) ev.overall_score = Math.min(90, ev.overall_score + 5);
  return ev;
}

async function saveDemoKb({ service, scenario, history, evaluation, consent, ip }) {
  if (!consent) return;
  const day = todayKey();
  const kbId = 'DEMO-KB-' + day;
  try {
    const rows = await sbGet('infinity_sessions');
    const existing = rows.find(r => r.id === kbId);
    const data = existing?.data || { sessions: [] };
    data.sessions.push({
      service, scenario,
      turns: (history || []).length,
      evaluation,
      connectors: detectConnectors((history || []).filter(m => m.role === 'user').map(m => m.content).join(' ')),
      ts: new Date().toISOString(),
      ipHash: ipStorageKey(ip || 'unknown')
    });
    if (data.sessions.length > 500) data.sessions = data.sessions.slice(-500);
    await sbSet('infinity_sessions', kbId, data);
  } catch (e) {
    console.error('Demo KB save failed:', e.message);
  }
}

async function getDemoSession(sessionId) {
  if (!sessionId) return null;
  try {
    const rows = await sbGet('infinity_sessions');
    const row = rows.find(r => r.id === 'DEMO-SESSION-' + sessionId);
    return row?.data || null;
  } catch (e) { return null; }
}

async function saveDemoSession(sessionId, data) {
  try {
    await sbSet('infinity_sessions', 'DEMO-SESSION-' + sessionId, data);
  } catch (e) {}
}

app.post('/demo/start', async (req, res) => {
  try {
    const { service, scenario, consent, name } = req.body || {};
    if (!consent) return res.status(400).json({ error: 'Consent required' });
    if (!['alice', 'nexora'].includes(service)) return res.status(400).json({ error: 'Invalid service' });

    const ip = getClientIp(req);
    const ipLimit = await checkDemoIpLimit(ip, service, { action: 'session' });
    if (!ipLimit.ok) {
      return res.status(429).json({
        error: 'limit',
        message: `Demo limit reached for today. Try again in ${ipLimit.wait}.`,
        wait: ipLimit.wait
      });
    }

    const buf = getDemoBuffer(service, scenario);
    if (!buf) return res.status(500).json({ error: 'Demo buffer unavailable' });

    const sessionId = crypto.randomUUID();
    const reply = buf.start.replace(/\*\*/g, '');
    const session = {
      service,
      scenario: scenario || (service === 'nexora' ? 'star' : 'default'),
      step: 0,
      name: name || 'Guest',
      consent: true,
      ip,
      history: [{ role: 'assistant', content: reply }],
      createdAt: new Date().toISOString(),
      apiCalls: 0
    };
    await saveDemoSession(sessionId, session);

    return res.json({
      sessionId,
      reply,
      step: 0,
      maxSteps: service === 'alice' ? DEMO_LIMITS.alice.maxSteps : DEMO_LIMITS.nexora.maxSteps,
      buffered: true,
      sessionsLeft: ipLimit.sessionsLeft,
      voiceProfile: getDemoVoiceProfileFor(service, scenario || (service === 'nexora' ? 'star' : 'default'))
    });
  } catch (err) {
    console.error('Demo start error:', err.message);
    return res.status(500).json({ error: 'Demo unavailable' });
  }
});

app.post('/demo/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message?.trim()) return res.status(400).json({ error: 'Missing sessionId or message' });

    const session = await getDemoSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session expired. Start a new demo.' });

    const ip = getClientIp(req);
    const ipLimit = await checkDemoIpLimit(ip, session.service, { action: 'message' });
    if (!ipLimit.ok) {
      return res.status(429).json({ error: 'limit', message: 'Daily demo message limit reached.', wait: ipLimit.wait });
    }

    const buf = getDemoBuffer(session.service, session.scenario);
    const maxSteps = session.service === 'alice' ? DEMO_LIMITS.alice.maxSteps : DEMO_LIMITS.nexora.maxSteps;

    session.history.push({ role: 'user', content: message.trim() });
    session.step++;

    const cacheK = bufferKey(session.service, session.scenario, session.step);
    if (demoResponseCache.has(cacheK)) {
      const cached = demoResponseCache.get(cacheK);
      session.history.push({ role: 'assistant', content: cached });
      await saveDemoSession(sessionId, session);
      return res.json({ reply: cached, step: session.step, done: session.step >= maxSteps, buffered: true, cacheHit: true });
    }

    let reply;
    let done = session.step >= maxSteps;

    if (done) {
      reply = buf.finish.reply;
    } else {
      reply = (buf.steps[session.step - 1] || buf.steps[buf.steps.length - 1]).replace(/\*\*/g, '');
    }

    cacheDemoResponse(cacheK, reply);
    session.history.push({ role: 'assistant', content: reply });
    await saveDemoSession(sessionId, session);

    const payload = { reply, step: session.step, done, buffered: true, maxSteps };
    if (done) {
      payload.evaluation = enrichEvaluation(buf.finish.evaluation, session.history);
      await saveDemoKb({
        service: session.service,
        scenario: session.scenario,
        history: session.history,
        evaluation: payload.evaluation,
        consent: session.consent,
        ip
      });
    }

    return res.json(payload);
  } catch (err) {
    console.error('Demo message error:', err.message);
    return res.status(500).json({ error: 'Demo unavailable' });
  }
});

app.get('/demo/status', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const service = req.query.service || 'alice';
    const { data } = await getIpRecord(ip);
    const day = todayKey();
    const bucket = data[service] || { day, sessions: 0, messages: 0 };
    const limits = DEMO_LIMITS[service] || DEMO_LIMITS.alice;
    const sessionsUsed = bucket.day === day ? bucket.sessions : 0;
    return res.json({
      service,
      sessionsUsed,
      sessionsLeft: Math.max(0, limits.sessionsPerDay - sessionsUsed),
      maxSteps: limits.maxSteps || 4
    });
  } catch (err) {
    return res.status(500).json({ error: 'Status unavailable' });
  }
});

app.get('/demo/voices', (req, res) => {
  try {
    return res.json(getDemoVoiceProfiles());
  } catch (err) {
    return res.status(500).json({ error: 'Voices unavailable' });
  }
});

app.post('/demo/tts', async (req, res) => {
  try {
    const { text, voiceId: bodyVoiceId } = req.body || {};
    const ip = getClientIp(req);
    const ipLimit = await checkDemoIpLimit(ip, 'tts', { action: 'tts' });
    if (!ipLimit.ok) {
      return res.status(429).json({ error: 'limit', message: 'Demo voice limit reached for today.' });
    }

    const allowlist = getDemoTtsAllowlist();
    if (!bodyVoiceId || !allowlist.has(bodyVoiceId)) {
      return res.status(400).json({ error: 'Voice not allowed for demo. Use voiceId from GET /demo/voices (your ElevenLabs account only).' });
    }

    const label = bodyVoiceId === ALICE_VOICE_ID ? 'Alice demo' : 'Nexora demo';
    return await synthesizeSpeech(req, res, { text, voiceId: bodyVoiceId, label });
  } catch (err) {
    console.error('Demo TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

// ── ALICE — Tutora de práctica ────────────────────────────────

// ── TTS CACHE (en memoria) ─────────────────────────────────────
// Evita llamadas repetidas a ElevenLabs para el mismo texto
const ttsCache = new Map();
const TTS_CACHE_MAX = 200; // máximo de entradas

function getTTSCacheKey(text, voiceId){
  return voiceId + ':' + text.slice(0, 100);
}

function cacheTTS(key, buffer){
  if(ttsCache.size >= TTS_CACHE_MAX){
    // Eliminar la entrada más vieja
    ttsCache.delete(ttsCache.keys().next().value);
  }
  ttsCache.set(key, buffer);
}

function cleanTtsText(text) {
  return (text || '')
    .replace(/ALICE:|CLAIRE:|JILL:/gi, '')
    .replace(/[*_#\[\]{}<>|~`^]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/!+/g, '.')
    .replace(/,/g, ' ')
    .replace(/;/g, ' ')
    .replace(/:/g, ' ')
    .replace(/<br>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim()
    .slice(0, 600);
}

async function synthesizeSpeech(req, res, { text, voiceId, label }) {
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (!ELEVEN_KEY) return res.status(500).json({ error: 'ELEVENLABS_KEY not configured' });
  if (!voiceId) return res.status(503).json({ error: `${label} voice ID not configured` });

  const clean = cleanTtsText(text);
  if (!clean) return res.status(400).json({ error: 'Empty text' });

  const cacheKey = getTTSCacheKey(clean, voiceId);
  if (ttsCache.has(cacheKey)) {
    const cached = ttsCache.get(cacheKey);
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'HIT');
    return res.send(cached);
  }

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text: clean,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
    })
  });

  if (!r.ok) {
    const err = await r.text();
    console.error(`${label} TTS error:`, err);
    return res.status(500).json({ error: 'TTS failed' });
  }

  const buf = Buffer.from(await r.arrayBuffer());
  cacheTTS(cacheKey, buf);
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');
  return res.send(buf);
}


app.post('/alice', requireProductAuth, async (req, res) => {
  try {
    const { student, history, message, mode, secret, nexora } = req.body || {};
    if (req.auth.role === 'student' && !assertStudentScope(req, student?.id)) {
      return res.status(403).json({ error: 'Student scope mismatch' });
    }

    const isKamuk = student?.id && student.id.startsWith('KAM-');
    const tutorName = 'Alice';
    const sessionTable = isKamuk ? 'kamuk_sessions' : 'infinity_sessions';

    // START SESSION
    if (mode === 'start_session') {
      const tb = (student?.trainingBook || []).slice(0,4)
        .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`).join('\n');

      const resp = await claudeCall({
        model: 'claude-haiku-4-5-20251001', max_tokens: 250,
        messages: [{ role: 'user', content: `You are Alice (your name is ALICE, not Alaiz, not Alicia — always ALICE). You are a warm and encouraging English tutor using the Nexus Method. Greet ${student?.name||'the student'} warmly by name (2-3 sentences max). Tell them you'll practice English together and ask ONE engaging open question to start. You are a tutor only — never roleplay as a customer, interviewer, or Nexora simulator.\n\nStudent level: ${student?.level||'Functional'}. Their exercises:\n${tb||'(none yet)'}\n\nEnd with: ALICE: [one motivating tip in Spanish]` }]
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

      const resp = await claudeCall({
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

    const systemPrompt = `You are Alice, a warm, patient, and encouraging English tutor. You love helping people and you never rush.

ROLE: You are a tutor and coach only. You NEVER roleplay as a customer, client, interviewer, manager, or any Nexora character. If the student asks you to simulate a scenario, explain warmly that simulations happen in Alice Mode through Nexora, and redirect to practice.

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
EXERCISES:\n${tb||'(none yet)'}`;

    const msgs = history?.length
      ? [...history.slice(-10), { role:'user', content:message }]
      : [{ role:'user', content:message }];

    const resp = await claudeCall({
      model: 'claude-haiku-4-5-20251001', max_tokens: 700,
      system: systemPrompt, messages: msgs
    });
    return res.json({ reply: resp.content.filter(b=>b.type==='text').map(b=>b.text).join('') });

  } catch(err) {
    console.error('Alice error:', err.message, err.status);
    return res.status(500).json({ error: 'Alice no está disponible ahora.', detail: err.message });
  }
});

// ── JILL — Tutora Foundations ────────────────────────────────
const JILL_SYSTEM_PROMPT = `Sos Jill, la tutora de Foundations de Studio Infinity CR.

IDENTIDAD:
Tu nombre es Jill. Sos paciente, cálida, amorosa y nunca generás presión. El estudiante que llega a vos ya intentó antes y falló — no por falta de esfuerzo sino porque ningún sistema anterior atacó el problema correcto. Tu trabajo empieza por reconstruir su confianza mientras simultáneamente construís las rutas neurales que le faltan.

Nunca juzgás. Nunca mostrás impaciencia. Celebrás cada avance, por pequeño que sea. Corregís siempre con afecto y claridad, nunca con frustración.

IDIOMA:
Hablás en español durante explicaciones, teoría, análisis y correcciones.
Practicás en inglés durante los ejercicios orales y de producción.
Cuando das un ejemplo en inglés, lo contextualizás en español primero.

FILOSOFÍA CENTRAL — Idea + Linker + Idea:
No enseñás inglés — enseñás a conectar ideas ya existentes usando andamiaje preestablecido.
El estudiante no construye cada frase desde cero. Ejecuta la fórmula y la llena con contenido.
Linkers clave: however, on top of that, even though, therefore, besides, so far, in other words, rather than, as long as, as a result, not only... but also, in addition to that, at the same time.

MÉTODO — CHUNKING:
El cerebro no procesa palabras individuales — procesa bloques.
Un hablante fluido no piensa I + want + to + say, piensa "I want to say" como una unidad.
Entrenás al estudiante a construir y almacenar chunks operacionales listos para usar.

PRESIÓN CERO:
Nunca presionás. El ambiente de Jill es práctica segura.
Equivocarse es parte del proceso y nunca tiene costo emocional.

LOS 8 KPIs QUE EVALUÁS:
1. Linkers y Connectors — ¿usa conectores naturalmente, mínimo 3 por respuesta?
2. Prefijos y Sufijos — ¿construye palabras usando modificadores (un-, re-, -tion, -ly)?
3. Tiempo Verbal y Transición — ¿se mueve entre tiempos fluidamente?
4. Estructura Oral — Apertura + Desarrollo + Cierre
5. Word Choice — ¿usa palabras precisas o siempre la más básica?
6. Entonación y Ritmo — ¿suena natural o telegráfico?
7. Expresiones y Frases Base — ¿usa chunks preestablecidos?
8. Recuperabilidad — ¿se detiene cuando comete un error o usa técnicas de recovery?

ROL EN ESTE SISTEMA:
Vos sos el Modo Jill. Mientras vos estás activa, el sistema está en modo aprendizaje.
NO simulás escenarios de trabajo, entrevistas, clientes ni llamadas.
NO evaluás para certificación ni ORT.
SÍ explicás, analizás, ejemplificás, guiás, enseñás y practicás con el estudiante.
Si el estudiante pregunta por simulaciones: le explicás que eso es Alice Mode y que su trainer lo activará cuando esté listo.

CONTENIDO ADAPTABLE:
Cuando querés mostrar algo visual o estructurado, usás el campo contentType en tu respuesta para señalarlo.
- "text" — respuesta conversacional normal
- "exercise" — ejercicio estructurado que el estudiante debe hacer
- "example" — demostración de una técnica con ejemplo concreto
- "whiteboard" — explicación estructurada como si fuera un pizarrón (listas, pasos, tabla)

RESPUESTA:
Respondé siempre en JSON válido con este formato:
{"reply":"tu respuesta aquí","contentType":"text|exercise|example|whiteboard"}
No uses markdown. No uses texto fuera del JSON.`;

// Extracts {reply, contentType} from Claude response regardless of markdown wrapping
function parseJillResponse(raw) {
  try {
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);
    if (parsed.reply) return parsed;
  } catch {}
  // Try to find JSON object anywhere in the string
  const match = raw.match(/\{[\s\S]*?"reply"\s*:\s*"([\s\S]*?)"[\s\S]*?\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  // Fallback: use raw text as reply
  return { reply: raw.replace(/```[\s\S]*?```/g, '').trim(), contentType: 'text' };
}

app.post('/jill', requireProductAuth, async (req, res) => {
  try {
    const { student, history, message, mode, weakKpis } = req.body || {};

    const name = student?.name || 'estudiante';
    const level = student?.level || 'Foundations';
    const exercises = (student?.trainingBook || []).slice(0, 4)
      .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`).join('\n');
    const weakNote = (weakKpis && weakKpis.length)
      ? `\nÁREAS DÉBILES EN QUIZ (reforzar hoy): ${weakKpis.join(', ')}.`
      : '';

    if (mode === 'start_session') {
      const resp = await claudeCall({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: JILL_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `El estudiante ${name} (nivel: ${level}) acaba de abrir su sesión. Saludalo con calidez, recordale en qué estaban trabajando si hay ejercicios asignados, y hacé UNA pregunta simple para arrancar.${weakNote}\nEjercicios asignados:\n${exercises || '(ninguno aún)'}\n\nRESPONDE ÚNICAMENTE con este JSON exacto, sin nada más antes ni después:\n{"reply":"tu saludo aquí","contentType":"text"}`
        }]
      });
      const raw = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      return res.json(parseJillResponse(raw));
    }

    if (!message) return res.status(400).json({ error: 'Missing message' });

    const prevMsgs = (history || []).slice(-12);
    const msgs = [...prevMsgs, { role: 'user', content: message }];
    const systemWithContext = JILL_SYSTEM_PROMPT + `\n\nESTUDIANTE: ${name} | Nivel: ${level}\nEJERCICIOS ASIGNADOS:\n${exercises || '(ninguno aún)'}${weakNote}\n\nRESPONDE ÚNICAMENTE con JSON: {"reply":"...","contentType":"text|exercise|example|whiteboard"} — sin texto fuera del JSON.`;

    const resp = await claudeCall({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemWithContext,
      messages: msgs
    });

    const raw = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return res.json(parseJillResponse(raw));

  } catch (err) {
    console.error('Jill error:', err.message, err.status);
    return res.status(500).json({ error: 'Jill no está disponible ahora.', detail: err.message });
  }
});

// ── STREAMING HELPER ─────────────────────────────────────────
async function streamAnthropicSSE(res, { model, max_tokens, system, messages }) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: max_tokens || 400, stream: true, system, messages })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    res.write(`data: ${JSON.stringify({ error: err?.error?.message || 'API error' })}\n\n`);
    return res.end();
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        const evt = JSON.parse(raw);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          res.write(`data: ${JSON.stringify({ t: evt.delta.text })}\n\n`);
        } else if (evt.type === 'message_stop') {
          res.write('data: [DONE]\n\n');
        }
      } catch {}
    }
  }
  res.end();
}

// ── JILL STREAM ──────────────────────────────────────────────
app.post('/jill/stream', requireProductAuth, async (req, res) => {
  try {
    const { student, history, message, weakKpis } = req.body || {};
    if (!message) return res.status(400).end();
    const name = student?.name || 'estudiante';
    const level = student?.level || 'Foundations';
    const exercises = (student?.trainingBook || []).slice(0, 4)
      .map(ex => `- ${ex.title}: ${ex.studentTask || ''}`).join('\n');
    const weakNote = weakKpis?.length ? `\nTemas a reforzar hoy: ${weakKpis.join(', ')}.` : '';
    const msgs = [...(history || []).slice(-10), { role: 'user', content: message }];
    await streamAnthropicSSE(res, {
      max_tokens: 400,
      system: JILL_SYSTEM_PROMPT + `\n\nESTUDIANTE: ${name} | Nivel: ${level}\nEJERCICIOS:\n${exercises || '(ninguno)'}${weakNote}\n\nResponde en texto directo, sin JSON, como en una conversación oral. Máx 4-5 oraciones. Completa siempre tu última oración.`,
      messages: msgs
    });
  } catch (err) {
    console.error('Jill stream error:', err.message);
    if (!res.headersSent) res.status(500).end(); else res.end();
  }
});

// ── ALICE STREAM ─────────────────────────────────────────────
app.post('/alice/stream', requireProductAuth, async (req, res) => {
  try {
    const { student, history, message, scenario, secret } = req.body || {};
    if (req.auth.role === 'student' && !assertStudentScope(req, student?.id)) {
      return res.status(403).json({ error: 'Student scope mismatch' });
    }
    if (!message) return res.status(400).end();
    const tb = (student?.trainingBook || []).slice(0, 5)
      .map(ex => `- ${ex.title} (${ex.kpi || ''}): ${ex.studentTask || ''}`).join('\n');
    const sceneNote = scenario ? `\nActive scenario: ${scenario.title || ''} — ${scenario.desc || ''}` : '';
    const system = `You are Alice, a warm, patient, and encouraging English tutor using the Nexus Method.
ROLE: Tutor only. NEVER roleplay as customer/interviewer/Nexora character.
PERSONALITY: Warm, human, celebratory, patient. Speak like a real person.
METHOD — NEXUS: Idea + Linker + Idea. Connectors: however, on top of that, even though, therefore, besides, so far, in other words.
RESPONSE STYLE: 3-4 natural sentences max. Complete every sentence. Ask ONE follow-up question. End with: ALICE: [one tip in Spanish].
STUDENT: ${student?.name || 'Student'} | Level: ${student?.level || 'Functional'}
EXERCISES:\n${tb || '(none yet)'}${sceneNote}`;
    const msgs = [...(history || []).slice(-10), { role: 'user', content: message }];
    await streamAnthropicSSE(res, { max_tokens: 350, system, messages: msgs });
  } catch (err) {
    console.error('Alice stream error:', err.message);
    if (!res.headersSent) res.status(500).end(); else res.end();
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
    const ip = getClientIp(req);

    if (mode === 'start') {
      const ipLimit = await checkDemoIpLimit(ip, 'claire', { action: 'session' });
      if (!ipLimit.ok) {
        return res.json({
          reply: 'Gracias por tu interés en Off The Clock. Alcanzaste el límite de conversaciones por hoy — escribinos al WhatsApp +506 6006 0981 o volvé mañana. 😊',
          limitReached: true
        });
      }
      const startBuffered = '¡Hola! Soy Claire de Off The Clock. Estoy acá para ayudarte a entender cómo desarrollamos comunicación operacional en inglés — no gramática de libro. ¿Qué te trae hoy?';
      return res.json({ reply: startBuffered, buffered: true });
    }

    const msgLimit = await checkDemoIpLimit(ip, 'claire', { action: 'message' });
    if (!msgLimit.ok) {
      return res.json({
        reply: 'Llegamos al límite de mensajes por hoy desde esta conexión. Agendá tu evaluación gratuita por WhatsApp: +506 6006 0981',
        limitReached: true
      });
    }

    if (!message?.trim()) return res.status(400).json({ error: 'Missing message' });

    // CHAT — cache key from last user message hash for repeated FAQ-style inputs
    const cacheKey = 'claire:' + crypto.createHash('md5').update((message || '').toLowerCase().trim().slice(0, 120)).digest('hex');
    if (demoResponseCache.has(cacheKey)) {
      return res.json({ reply: demoResponseCache.get(cacheKey), buffered: true, cacheHit: true });
    }
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

    const resp = await claudeCall({
      model: 'claude-sonnet-4-6', max_tokens: 150,
      system: systemPrompt, messages: msgs
    });
    const reply = resp.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    if (reply.length > 20) cacheDemoResponse(cacheKey, reply);
    return res.json({ reply });

  } catch(err) {
    console.error('Claire error:', err.message);
    return res.status(500).json({ error: 'Claire no está disponible ahora.' });
  }
});

// ── ELEVENLABS TTS ───────────────────────────────────────────
app.post('/claire-tts', optionalAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    return await synthesizeSpeech(req, res, { text, voiceId: CLAIRE_VOICE_ID, label: 'Claire' });
  } catch (err) {
    console.error('Claire TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

app.post('/alice-tts', requireProductAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    return await synthesizeSpeech(req, res, { text, voiceId: ALICE_VOICE_ID, label: 'Alice' });
  } catch (err) {
    console.error('Alice TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

app.post('/jill-tts', requireProductAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    return await synthesizeSpeech(req, res, { text, voiceId: JILL_VOICE_ID, label: 'Jill' });
  } catch (err) {
    console.error('Jill TTS error:', err.message);
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
      const elevenKey = process.env.ELEVENLABS_KEY || '';
      const eRes = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': elevenKey }
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
app.post('/nexora-tts', requireProductAuth, async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};
    return await synthesizeSpeech(req, res, {
      text,
      voiceId: voiceId || ALICE_VOICE_ID,
      label: 'Nexora'
    });
  } catch (err) {
    console.error('Nexora TTS error:', err.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }
});

// ── NEXORA CALL SIMULATION ────────────────────────────────────
app.post('/nexora', requireProductAuth, async (req, res) => {
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

    if(scType === 'star_interview'){
      const ctx = accountContext || {};
      const starFocusStr = ctx.starFocus && ctx.starFocus.length ? ctx.starFocus.map((q,i) => (i+1)+'. '+q).join('\n') : 'General STAR questions';
      systemPrompt = `You are ${ctx.interviewerName || 'a senior interviewer'} conducting a structured STAR behavioral interview for: ${sc.title}.
Company: ${ctx.company || sc.company || 'the company'}

STAR FOCUS QUESTIONS (use these as your guide):
${starFocusStr}

YOUR ROLE:
- YOU are the interviewer. ${agentName} is the candidate being evaluated.
- Ask strictly STAR-format questions: Situation, Task, Action, Result.
- Probe for specifics: "What was YOUR specific action?" "What was the measurable result?"
- If they skip a STAR component: "You've described the situation — what specific actions did YOU take?"
- Evaluate clarity, structure, connector usage, confidence and specific examples.
- After 2-3 exchanges, give brief feedback and move to the next question.
- 1-3 sentences per turn. Professional and focused.
- Your name is ${ctx.interviewerName || 'the interviewer'}. NEVER change your name.
- NEVER break character. You are the interviewer, ${agentName} is the one being evaluated.`;
    } else if(scType === 'interview'){
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
- Your name is ${ctx.interviewerName || p.name}. NEVER introduce yourself with a different name.
- NEVER mention English tutoring, learning or AI. YOU are the interviewer, ${agentName} is the candidate being evaluated.`;
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
      const negRole = req.body.negRole || 'initiator'; // 'initiator' = user makes offer, 'receiver' = Alice makes offer
      const ctx = accountContext || {};
      systemPrompt = `You are ${sc.counterpart || 'a negotiation counterpart'} in a professional negotiation.
Context: ${sc.title} — ${sc.desc}

${negRole === 'receiver'
  ? `OPENING ROLE: YOU go first. Make your opening offer or state your position clearly. ${agentName} will respond and counter-negotiate.`
  : `OPENING ROLE: ${agentName} will open the negotiation with their offer or position. You respond to what they propose.`
}

YOUR APPROACH:
- Be firm on your key points but open to genuine compromise.
- Strong, logical arguments from ${agentName} move you. Weak arguments get pushback.
- Use negotiation language: "I understand your position, however...", "We could consider that if...", "That doesn't work for us unless..."
- If ${agentName} finds creative win-win solutions → acknowledge and show flexibility.
- If ${agentName} is aggressive or unreasonable → hold firm or signal disengagement.
- Track what has been agreed and what is still open.
- 1-3 sentences per turn. Professional, direct.
- NEVER break character or mention AI. You are evaluating ${agentName}'s negotiation skills.`;
    } else if(scType === 'corporate'){
      const ctx = accountContext || {};
      const pdfContext = ctx.pdfContent ? `\n\nPRESENTATION CONTENT (the candidate uploaded this for you to review):\n${ctx.pdfContent.slice(0,2000)}` : '';
      const stakesStr = ctx.stakes && ctx.stakes.length ? ctx.stakes.join('; ') : '';
      systemPrompt = `You are ${sc.role || 'a Board Director'} at ${sc.company || 'the company'}.
Meeting: ${sc.title}
Context: ${sc.desc}
${stakesStr ? 'Key concerns: '+stakesStr : ''}${pdfContext}

YOUR ROLE:
- YOU are the executive/director. ${agentName} is presenting TO YOU and being evaluated.
- Be demanding. Expect precision, data and clear ROI from ${agentName}.
- Challenge weak points: "What's the evidence for that assumption?"
- Ask about risks, timelines, financials and strategic fit.
- React positively when ${agentName} is structured, confident and data-driven.
- React skeptically when ${agentName} is vague or unconfident.
- You decide whether to approve, reject or request more information.
- 1-3 sentences per turn. Boardroom pace.
- Your name/role is ${sc.role || 'Board Director'}. NEVER introduce yourself with a different name.
- NEVER break character or mention AI. You are evaluating ${agentName}.`;

    } else if(scType === 'stakeholder'){
      const ctx = accountContext || {};
      const stakesStr = ctx.stakes && ctx.stakes.length ? '\nKey tensions:\n'+ctx.stakes.map(s=>'- '+s).join('\n') : '';
      systemPrompt = `You are ${sc.role || 'a key stakeholder'} in a high-stakes meeting.
Meeting: ${sc.title}
Context: ${sc.desc}${stakesStr}
Participants: ${(ctx.participants||[]).join(', ')}

YOUR ROLE:
- YOU are the stakeholder with a specific agenda. ${agentName} must manage YOU and align you.
- Push for YOUR priorities and create realistic friction.
- ${agentName} is being evaluated on their ability to handle difficult stakeholders.
- If ${agentName} addresses your concerns clearly and professionally → gradually align.
- If ${agentName} is vague, dismissive or unprepared → escalate your resistance.
- Use stakeholder language: "From our department's perspective...", "We need to ensure..."
- 1-3 sentences. You are testing ${agentName}'s stakeholder management skills.
- NEVER break character.`;

    } else if(scType === 'medical'){
      systemPrompt = `You are ${p.name || 'a patient'} speaking with a healthcare provider.
Situation: ${sc.desc}
Your mood: ${mood}

YOUR ROLE:
- YOU are the patient. ${agentName} is the healthcare provider being evaluated.
- Ask questions, express worry or resistance naturally based on your mood.
- Evaluate (internally) how clearly and empathetically ${agentName} communicates.
- If ${agentName} is clear and empathetic → you feel reassured and cooperative.
- If ${agentName} is confusing, cold or unprofessional → become more anxious or resistant.
- Use natural patient language. 1-3 sentences per turn.
- NEVER break character. You are evaluating ${agentName}'s patient communication skills.`;

    } else {
      // Default: customer service
      systemPrompt = `You are ${p.name || 'a customer'}, account ${p.account || 'unknown'}, calling customer service.

YOUR ISSUE: ${sc.title} — ${sc.desc}
YOUR MOOD: ${mood}
${accountDetails}

CRITICAL RULES:
- Your name is ${p.name}. NEVER change your name or introduce yourself with a different name under any circumstances.
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

    const resp = await claudeCall({
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
app.post('/nexora-eval', requireProductAuth, async (req, res) => {
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

    const resp = await claudeCall({
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
    const resp = await claudeCall({
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

    const resp = await claudeCall({
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

app.use((err, req, res, next) => {
  if (err && err.message === 'CORS not allowed') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next(err);
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
