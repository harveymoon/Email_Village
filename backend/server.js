// Town Inbox backend — minimal Express + googleapis server.
// Derived from Visual_Email/backend/server.js; trimmed to only what
// the game needs (auth + Gmail proxy, no AI, no SPA static serving).

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import gmailRoutes from './routes/gmail.js';
import { bootstrapSync } from './services/syncEngine.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Default 3091 — picked to avoid the very-common :3000 (used by CRA,
// Express scaffolds, lots of other tools). Override via PORT env var.
const PORT = process.env.PORT || 3091;

// CORS: any localhost origin (so Vite can pick whichever port). Override
// with FRONTEND_URL in production.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);          // curl / same-origin
    // Electron loads packaged renderer from file:// which sends the
    // literal string "null" as Origin. Allow it explicitly.
    if (origin === 'null') return callback(null, true);
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) return callback(null, true);
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return callback(null, true);
    console.warn('[cors] rejecting origin:', origin);
    callback(new Error(`CORS: origin not allowed: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'little-town-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    // SameSite=Lax allows the cookie to travel between localhost:3000 and
    // localhost:5173 (same registrable site, different ports).
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use('/auth', authRoutes);
app.use('/api', gmailRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Packaged-app self-serving: when TOWN_INBOX_RENDERER_DIR is set
// (electron/main.cjs sets it to the unpacked dist/ resource dir), serve
// the built renderer from the same origin as the API. Same-origin
// means session cookies + CORS Just Work — no file://-Origin: null
// gymnastics required.
//
// Dev (Vite on :5173) doesn't set this env; the / route below still
// renders the friendly landing page in that case.
const rendererDir = process.env.TOWN_INBOX_RENDERER_DIR;
if (rendererDir) {
  console.log(`📦 serving renderer from ${rendererDir}`);
  app.use(express.static(rendererDir));
}

// Friendly landing message in case someone (or future-you) visits the
// backend in a browser. The actual UI is the Phaser game on Vite's port.
app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html><head><title>Town Inbox backend</title>
    <style>body{background:#111;color:#eee;font:16px ui-sans-serif,system-ui,sans-serif;padding:40px;max-width:640px;margin:0 auto;line-height:1.6}a{color:#7af}code{background:#222;padding:2px 6px;border-radius:3px}</style>
    </head><body>
    <h1>🏘️ Town Inbox backend</h1>
    <p>This is the Gmail-proxy API. There's no UI here.</p>
    <p>The game lives at <a href="http://localhost:5173/">http://localhost:5173/</a>.</p>
    <p>Endpoints: <code>/auth/status</code>, <code>/auth/google</code>, <code>/api/profile</code>,
       <code>/api/labels</code>, <code>/api/emails</code>, <code>/api/threads/:id</code>,
       <code>/api/threads/:id/reply</code>, <code>/api/emails/:id/labels</code>,
       <code>/api/emails/:id/read</code>, <code>/health</code>.</p>
    </body></html>
  `);
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

app.listen(PORT, () => {
  console.log(`\n🏘️  Town Inbox backend running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log(`\n⚠️  Gmail not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env`);
  }
  // Kick off sync after auth.js has loaded its token store (which it
  // does at import time). Run on next tick so the listen() callback's
  // log line lands before the sync engine starts noisily logging.
  setImmediate(() => bootstrapSync().catch(err => console.error('[sync] bootstrap failed:', err)));
});

export default app;
