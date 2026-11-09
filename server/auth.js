import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';

export async function seedAgent() {
  if (!config.agentEmail || !config.agentPassword) return;
  const hash = await bcrypt.hash(config.agentPassword, 10);
  await pool.query(
    `INSERT INTO agents (brand_id, email, password_hash) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [config.brandId, config.agentEmail.toLowerCase(), hash],
  );
}

export async function login(email, password) {
  const { rows: [agent] } = await pool.query(`SELECT * FROM agents WHERE email = $1`, [String(email || '').toLowerCase()]);
  // Compare even when the agent is missing, so timing does not reveal which emails exist.
  const ok = await bcrypt.compare(String(password || ''), agent?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!agent || !ok) return null;
  return jwt.sign({ sub: String(agent.id), brand: agent.brand_id, email: agent.email }, config.jwtSecret, { expiresIn: '12h' });
}

export function requireAgent(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const claims = jwt.verify(token, config.jwtSecret);
    req.agent = { id: claims.sub, brandId: claims.brand, email: claims.email };
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in' });
  }
}

// Small in-memory limiter for login. Fine for one instance; use a shared store when scaled out.
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
  recent.push(now);
  attempts.set(key, recent);
  next();
}
