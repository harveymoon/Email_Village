// Multi-account Google OAuth authentication.
//
// Token file shape:
//   { "accounts": { "<email>": { "tokens": {...}, "user": {...} } } }
// Backwards-compatible read of the old single-account shape
//   { "tokens": {...}, "user": {...} }
// migrates on first load.
//
// Session shape:
//   req.session.accounts: string[]   // emails of accounts active this session
// Helpers exposed to gmail.js via `requireAuth`:
//   req.oauth2Clients: Record<email, OAuth2Client>
//   req.activeAccounts: string[]
//
// invalid_grant on any account quietly removes JUST that account (so a stale
// refresh token on one doesn't disable the rest).

import express from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const TOKEN_FILE = path.join(__dirname, '..', '.gmail-tokens.json');

// In-memory store keyed by lowercased email. Persisted to TOKEN_FILE.
let store = { accounts: /** @type {Record<string, {tokens: any, user: any}>} */ ({}) };

function loadStore() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (raw.accounts && typeof raw.accounts === 'object') {
      store.accounts = raw.accounts;
    } else if (raw.tokens && raw.user?.email) {
      // Migrate legacy single-account shape.
      store.accounts = { [raw.user.email.toLowerCase()]: { tokens: raw.tokens, user: raw.user } };
      persistStore();
      console.log('📦 Migrated single-account token file → multi-account shape');
    }
    const list = Object.keys(store.accounts);
    if (list.length) console.log(`📧 Loaded ${list.length} saved Gmail account(s): ${list.join(', ')}`);
  } catch (err) {
    console.warn('Failed to load saved tokens:', err.message);
  }
}

function persistStore() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to save tokens:', err.message);
  }
}

function upsertAccount(tokens, user) {
  const email = user?.email?.toLowerCase();
  if (!email) throw new Error('upsertAccount: user.email is required');
  store.accounts[email] = { tokens, user };
  persistStore();
  console.log(`💾 Saved tokens for ${email}`);
}

function removeAccount(email) {
  const key = (email || '').toLowerCase();
  if (!store.accounts[key]) return false;
  delete store.accounts[key];
  persistStore();
  console.log(`🗑️  Removed account ${key}`);
  return true;
}

loadStore();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3091/auth/callback'
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  // settings.basic enables filter CRUD via users.settings.filters.*
  // Existing tokens DON'T have this — accounts need to re-auth via the
  // ↻ button on each auth chip in the game.
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// Default session.accounts to everything in the store the first time we see
// the request. Caller can later disconnect specific ones via /auth/disconnect.
function ensureSessionAccounts(req) {
  if (!req.session) return;
  if (!Array.isArray(req.session.accounts)) {
    req.session.accounts = Object.keys(store.accounts);
  } else {
    // Drop any session entries that aren't in the store (e.g. removed via disconnect).
    req.session.accounts = req.session.accounts.filter(e => store.accounts[e]);
  }
}

// -------------------- /auth/status --------------------
router.get('/status', async (req, res) => {
  ensureSessionAccounts(req);
  const emails = req.session.accounts || [];
  // Best-effort refresh for any account whose refresh_token is present.
  for (const email of [...emails]) {
    const entry = store.accounts[email];
    if (!entry?.tokens?.refresh_token) continue;
    try {
      const client = getOAuth2Client();
      client.setCredentials(entry.tokens);
      const { credentials } = await client.refreshAccessToken();
      store.accounts[email].tokens = credentials;
      persistStore();
    } catch (err) {
      if (err.message?.includes('invalid_grant')) {
        console.warn(`🗑️  invalid_grant on ${email} — dropping account`);
        removeAccount(email);
        req.session.accounts = req.session.accounts.filter(e => e !== email);
      } else {
        console.warn(`Token refresh failed for ${email}:`, err.message);
      }
    }
  }
  const accounts = (req.session.accounts || []).map(email => {
    const u = store.accounts[email]?.user || { email };
    return { email: u.email, name: u.name, picture: u.picture };
  });
  res.json({ authenticated: accounts.length > 0, accounts });
});

// -------------------- /auth/google --------------------
// ?return_to=<url>   — bounce target after OAuth completes
// ?add=true          — append to current session.accounts instead of replacing
router.get('/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).json({
      error: 'Gmail integration not configured',
      message: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env',
    });
  }
  const client = getOAuth2Client();
  const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : null;
  const add = req.query.add === 'true' || req.query.add === '1';
  // ?reauth=<email> — re-grant THIS account specifically. Uses
  // login_hint to pre-select the right Google account on the chooser
  // (skips the picker if the user is already signed into Google with
  // that account).
  const reauth = typeof req.query.reauth === 'string' ? req.query.reauth : null;
  const state = Buffer.from(JSON.stringify({ returnTo, add: add || !!reauth })).toString('base64url');
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
    login_hint: reauth || undefined,
  });
  res.redirect(authUrl);
});

// -------------------- /auth/callback --------------------
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  let returnTo = '/';
  let add = false;
  if (typeof state === 'string') {
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
      if (typeof parsed.returnTo === 'string' &&
          /^https?:\/\/localhost(:\d+)?(\/.*)?$/i.test(parsed.returnTo)) {
        returnTo = parsed.returnTo;
      }
      add = !!parsed.add;
    } catch { /* fall through */ }
  }
  const appendQuery = (url, qs) => url + (url.includes('?') ? '&' : '?') + qs;

  if (error) {
    console.error('OAuth error:', error);
    return res.redirect(appendQuery(returnTo, 'auth_error=' + encodeURIComponent(String(error))));
  }
  if (!code) return res.redirect(appendQuery(returnTo, 'auth_error=no_code'));

  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    const user = {
      email: userInfo.data.email,
      name: userInfo.data.name,
      picture: userInfo.data.picture,
    };
    const emailKey = user.email.toLowerCase();
    upsertAccount(tokens, user);
    // Update session: if add=true, append; else REPLACE session with just
    // the new account (intended as "sign in fresh as this user").
    ensureSessionAccounts(req);
    if (add) {
      if (!req.session.accounts.includes(emailKey)) req.session.accounts.push(emailKey);
    } else {
      req.session.accounts = [emailKey];
    }
    console.log(`✅ Authenticated ${emailKey} (session now: ${req.session.accounts.join(', ')})`);
    res.redirect(appendQuery(returnTo, 'auth_success=true'));
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(appendQuery(returnTo, 'auth_error=' + encodeURIComponent(err.message)));
  }
});

// -------------------- /auth/disconnect/:email --------------------
router.post('/disconnect/:email', (req, res) => {
  const email = (req.params.email || '').toLowerCase();
  const ok = removeAccount(email);
  if (req.session?.accounts) {
    req.session.accounts = req.session.accounts.filter(e => e !== email);
  }
  res.json({ success: ok, remaining: Object.keys(store.accounts) });
});

// Legacy logout — wipes the whole session.
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

// -------------------- middleware --------------------
// Provides req.oauth2Clients (keyed by lower-cased email) and req.activeAccounts.
// 401 if zero active accounts.
export function requireAuth(req, res, next) {
  ensureSessionAccounts(req);
  const emails = req.session.accounts || [];
  if (!emails.length) return res.status(401).json({ error: 'Not authenticated' });
  const clients = {};
  for (const email of emails) {
    const entry = store.accounts[email];
    if (!entry?.tokens?.access_token) continue;
    const c = getOAuth2Client();
    c.setCredentials(entry.tokens);
    clients[email] = c;
  }
  if (!Object.keys(clients).length) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.oauth2Clients = clients;
  req.activeAccounts = Object.keys(clients);
  next();
}

// Helper for gmail.js: drop a single account if its refresh fails.
export function dropAccountForInvalidGrant(email) {
  removeAccount((email || '').toLowerCase());
}

export default router;
