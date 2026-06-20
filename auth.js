const crypto = require('crypto');

const JWT_EXPIRY_SEC = parseInt(process.env.JWT_EXPIRY_SEC || '86400', 10); // 24h
const JWT_SECRET = process.env.JWT_SECRET || process.env.ANALYZE_SECRET || '';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, expiresInSec = JWT_EXPIRY_SEC) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + expiresInSec
  }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!JWT_SECRET || !token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(allowedRoles = []) {
  return (req, res, next) => {
    const raw = req.headers.authorization || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: 'Forbidden', code: 'ROLE_DENIED' });
    }
    req.auth = payload;
    next();
  };
}

/** Public routes (Claire, demos) — optional auth enriches logging only */
function optionalAuth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  req.auth = verifyToken(token) || null;
  next();
}

module.exports = {
  JWT_EXPIRY_SEC,
  JWT_SECRET,
  signToken,
  verifyToken,
  requireAuth,
  optionalAuth
};
