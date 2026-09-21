// Google Sheets, write side only: an OAuth desktop client, a stored refresh
// token, and "replace everything on this sheet with these rows".
//
// The app hosts its own redirect: you approve once in a browser and the
// token lives in data/google-token.json. Writes then go as you, so any
// sheet you can already edit works without sharing anything.
import express from 'express';
import crypto from 'node:crypto';
import { read, write, exists, removeFile, DEFAULT_SETTINGS } from './store.js';

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const SHEETS_API = process.env.GOOGLE_SHEETS_API || 'https://sheets.googleapis.com/v4/spreadsheets';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'email'];

const settings = () => ({ ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) });
const tokens = () => read('google-token', null);

export const clientConfigured = () => {
  const s = settings();
  return !!(s.googleClientId && s.googleClientSecret);
};

export const connected = () => !!tokens()?.refresh_token;

/**
 * Where Google sends you back. It has to match a redirect URI registered on
 * the OAuth client exactly, so it is derived from the URL you are using —
 * and shown in Settings, to be copied into the Google console.
 */
export function redirectUri(req) {
  const base = process.env.GOOGLE_REDIRECT_BASE || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/google/callback`;
}

// One pending sign-in at a time; `state` guards against a stray callback.
let pending = null;

export function authUrl(req) {
  const s = settings();
  if (!clientConfigured()) throw new Error('No Google OAuth client yet. Add the client id and secret on the Settings tab.');
  const state = crypto.randomBytes(16).toString('hex');
  pending = { state, redirect: redirectUri(req), at: Date.now() };
  const q = new URLSearchParams({
    client_id: s.googleClientId,
    redirect_uri: pending.redirect,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // A refresh token comes back only on the first consent unless we insist.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Google: ${data.error_description || data.error || res.statusText}`);
  }
  return data;
}

/** The email is in the id_token; reading it saves a second round trip. */
function emailFrom(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || '';
  } catch {
    return '';
  }
}

export async function exchangeCode(code, state) {
  if (!pending || pending.state !== state) throw new Error('That sign-in did not start here. Try connecting again.');
  const s = settings();
  const data = await tokenRequest({
    code,
    client_id: s.googleClientId,
    client_secret: s.googleClientSecret,
    redirect_uri: pending.redirect,
    grant_type: 'authorization_code',
  });
  pending = null;
  const saved = {
    refresh_token: data.refresh_token || tokens()?.refresh_token || '',
    access_token: data.access_token || '',
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    email: data.id_token ? emailFrom(data.id_token) : tokens()?.email || '',
    connectedAt: new Date().toISOString(),
  };
  if (!saved.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  }
  write('google-token', saved);
  return saved;
}

/** A live access token, refreshed a minute before it actually expires. */
async function accessToken() {
  const t = tokens();
  if (!t?.refresh_token) throw new Error('Not connected to Google. Connect on the Settings tab.');
  if (t.access_token && t.expiresAt - 60_000 > Date.now()) return t.access_token;

  const s = settings();
  const data = await tokenRequest({
    refresh_token: t.refresh_token,
    client_id: s.googleClientId,
    client_secret: s.googleClientSecret,
    grant_type: 'refresh_token',
  });
  const next = {
    ...t,
    access_token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  write('google-token', next);
  return next.access_token;
}

export function disconnect() {
  if (exists('google-token')) removeFile('google-token');
  pending = null;
}

export function status() {
  const t = tokens();
  return {
    clientConfigured: clientConfigured(),
    connected: !!t?.refresh_token,
    email: t?.email || '',
    connectedAt: t?.connectedAt || null,
  };
}

// ------------------------------------------------------------------ sheets

/**
 * Pull the spreadsheet id and the tab out of a pasted URL. Google's own URLs
 * carry the tab as `#gid=…`, which is what you get from the address bar.
 */
export function parseSheetUrl(url) {
  const text = String(url || '').trim();
  if (!text) throw new Error('Paste the Google Sheet URL.');
  const id = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
  if (!id) throw new Error('That does not look like a Google Sheet URL (…/spreadsheets/d/…).');
  const gid = text.match(/[#&?]gid=(\d+)/)?.[1];
  return { spreadsheetId: id, gid: gid ? Number(gid) : null, url: text };
}

async function sheetsFetch(path, opts = {}) {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), authorization: `Bearer ${await accessToken()}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 403) throw new Error(`Google refused the write: ${msg}. Can this account edit that sheet?`);
    if (res.status === 404) throw new Error('No such Google Sheet — check the URL.');
    throw new Error(`Google Sheets: ${msg}`);
  }
  return data;
}

/** The tab to write to: the one in the URL, else the first one. */
async function targetTab(spreadsheetId, gid) {
  const meta = await sheetsFetch(`/${spreadsheetId}?fields=properties.title,sheets.properties`);
  const sheets = (meta.sheets || []).map((s) => s.properties);
  if (!sheets.length) throw new Error('That spreadsheet has no sheets.');
  const tab = gid == null ? sheets[0] : sheets.find((s) => s.sheetId === gid);
  if (!tab) throw new Error(`That spreadsheet has no tab with gid ${gid}.`);
  return { title: tab.title, sheetId: tab.sheetId, file: meta.properties?.title || '' };
}

const a1 = (title) => `'${String(title).replace(/'/g, "''")}'`;

/**
 * Replace everything on one tab with `rows`. Clear first, so a shorter
 * table does not leave the tail of the previous one behind.
 */
export async function overwriteSheet({ spreadsheetId, gid, rows }) {
  const tab = await targetTab(spreadsheetId, gid);
  await sheetsFetch(`/${spreadsheetId}/values/${encodeURIComponent(a1(tab.title))}:clear`, { method: 'POST' });
  const range = `${a1(tab.title)}!A1`;
  await sheetsFetch(
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW&includeValuesInResponse=false`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows }),
    }
  );
  return { tab: tab.title, file: tab.file, rows: rows.length, columns: rows[0]?.length || 0 };
}

// ------------------------------------------------------------------ routes

export const googleRoutes = express.Router();

const fail = (res, err) => res.status(err.status || 400).json({ error: err.message });

googleRoutes.get('/status', (req, res) => res.json({ ...status(), redirectUri: redirectUri(req) }));

// The UI opens this in a tab; it bounces straight to Google's consent page.
googleRoutes.get('/connect', (req, res) => {
  try {
    res.redirect(authUrl(req));
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Where Google comes back to. This lands in a browser tab, so it answers in
// HTML rather than JSON, and closes itself.
googleRoutes.get('/callback', async (req, res) => {
  const done = (msg, ok) =>
    res.send(
      `<!doctype html><meta charset="utf-8"><title>Google</title>` +
        `<body style="font:14px system-ui;padding:40px;color:${ok ? '#1c6b40' : '#b4342a'}">` +
        `<p>${msg}</p><p style="color:#777">You can close this tab.</p>` +
        (ok ? '<script>setTimeout(() => window.close(), 1500)</script>' : '') +
        `</body>`
    );
  if (req.query.error) return done(`Google said: ${req.query.error}`, false);
  try {
    const t = await exchangeCode(req.query.code, req.query.state);
    done(`Connected to Google as ${t.email || 'your account'}.`, true);
  } catch (err) {
    done(err.message, false);
  }
});

googleRoutes.post('/disconnect', (_req, res) => {
  disconnect();
  res.json({ ok: true, ...status() });
});
