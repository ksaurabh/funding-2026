import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { csvToRecords, toCsv } from './csv.js';
import { read, write, ROOT, DEFAULT_SETTINGS, DEFAULT_PLAYBOOK } from './store.js';
import { startRun, jobStatus, cancelJob, renderTemplate, slugify } from './runner.js';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/csv', limit: '50mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ------------------------------------------------------------------ helpers

function investorId(row, columns, index) {
  const name = String(row[columns[0]] ?? '').trim();
  if (!name) return `row_${index}`;
  return crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12);
}

function importCsv(text, sourceName) {
  const { columns, records } = csvToRecords(text);
  if (!columns.length) throw new Error('That CSV has no header row.');
  const seen = new Set();
  const rows = records.map((r, i) => {
    let id = investorId(r, columns, i);
    while (seen.has(id)) id = id + '_' + i;
    seen.add(id);
    return { __id: id, ...r };
  });
  return write('investors', {
    columns,
    rows,
    source: sourceName,
    importedAt: new Date().toISOString(),
  });
}

function getInvestors() {
  return read('investors', { columns: [], rows: [], source: null });
}

// Seed from the CSV sitting next to the app so the first run isn't empty.
function seedIfEmpty() {
  const current = getInvestors();
  if (current.rows.length) return;
  const seed = path.join(ROOT, 'funding-round-investors.csv');
  if (!fs.existsSync(seed)) return;
  importCsv(fs.readFileSync(seed, 'utf8'), 'funding-round-investors.csv');
  console.log('Seeded investors from funding-round-investors.csv');
}

// ----------------------------------------------------------------- settings

app.get('/api/settings', (_req, res) => {
  const s = { ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) };
  res.json({
    ...s,
    apiKey: undefined,
    apiKeySet: !!s.apiKey,
    apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '',
    envKeyAvailable: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.put('/api/settings', (req, res) => {
  const current = { ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) };
  const body = req.body || {};
  const next = {
    ...current,
    model: body.model ?? current.model,
    effort: body.effort ?? current.effort,
    maxTokens: Number(body.maxTokens) || current.maxTokens,
    concurrency: Math.max(1, Math.min(8, Number(body.concurrency) || current.concurrency)),
  };
  // Only overwrite the key when a new one is actually supplied.
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
  if (body.clearApiKey) next.apiKey = '';
  write('settings', next);
  res.json({ ok: true });
});

// ----------------------------------------------------------------- playbook

app.get('/api/playbook', (_req, res) => {
  res.json(read('playbook', DEFAULT_PLAYBOOK));
});

app.put('/api/playbook', (req, res) => {
  const body = req.body || {};
  const steps = (body.steps || []).map((s, i) => ({
    id: s.id || crypto.randomUUID(),
    name: (s.name || `Step ${i + 1}`).trim(),
    key: slugify(s.key || s.name || `step_${i + 1}`),
    prompt: s.prompt || '',
    webSearch: !!s.webSearch,
    enabled: s.enabled !== false,
  }));
  const playbook = {
    system: body.system ?? DEFAULT_PLAYBOOK.system,
    mode: body.mode === 'independent' ? 'independent' : 'conversation',
    steps,
  };
  write('playbook', playbook);
  res.json(playbook);
});

// Render a step's prompt against one investor, without calling the model.
app.post('/api/playbook/preview', (req, res) => {
  const { prompt, investorId: id } = req.body || {};
  const investors = getInvestors();
  const row = investors.rows.find((r) => r.__id === id) || investors.rows[0];
  if (!row) return res.status(400).json({ error: 'No investors loaded.' });
  res.json(renderTemplate(prompt, row, {}));
});

// ---------------------------------------------------------------- investors

app.get('/api/investors', (_req, res) => {
  const investors = getInvestors();
  const answers = read('answers', {});
  const playbook = read('playbook', DEFAULT_PLAYBOOK);
  const enabled = playbook.steps.filter((s) => s.enabled !== false);

  const rows = investors.rows.map((r) => {
    const entry = answers[r.__id];
    const done = enabled.filter((s) => entry?.steps?.[s.id]?.text).length;
    const errors = enabled.filter((s) => entry?.steps?.[s.id]?.error).length;
    return { ...r, __done: done, __errors: errors, __updatedAt: entry?.updatedAt || null };
  });

  res.json({ ...investors, rows, stepCount: enabled.length });
});

app.post('/api/investors/import', (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!text) return res.status(400).json({ error: 'No CSV content received.' });
    const name = (typeof req.body === 'object' && req.body?.name) || 'uploaded.csv';
    res.json(importCsv(text, name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/investors/:id', (req, res) => {
  const investors = getInvestors();
  const row = investors.rows.find((r) => r.__id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Investor not found.' });
  const playbook = read('playbook', DEFAULT_PLAYBOOK);
  const entry = read('answers', {})[req.params.id] || { steps: {} };
  res.json({
    investor: row,
    columns: investors.columns,
    steps: playbook.steps.map((s) => ({ ...s, answer: entry.steps?.[s.id] || null })),
    updatedAt: entry.updatedAt || null,
  });
});

app.delete('/api/investors/:id/answers', (req, res) => {
  const answers = read('answers', {});
  delete answers[req.params.id];
  write('answers', answers);
  res.json({ ok: true });
});

// --------------------------------------------------------------------- runs

app.post('/api/run', (req, res) => {
  try {
    const investors = getInvestors();
    const body = req.body || {};
    let ids = body.investorIds;
    if (body.scope === 'all' || !ids) ids = investors.rows.map((r) => r.__id);
    if (body.scope === 'unanswered') {
      const answers = read('answers', {});
      const playbook = read('playbook', DEFAULT_PLAYBOOK);
      const enabled = playbook.steps.filter((s) => s.enabled !== false);
      ids = investors.rows
        .filter((r) => enabled.some((s) => !answers[r.__id]?.steps?.[s.id]?.text))
        .map((r) => r.__id);
    }
    res.json(startRun({ investorIds: ids, stepIds: body.stepIds }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/run/status', (_req, res) => res.json(jobStatus()));
app.post('/api/run/cancel', (_req, res) => res.json({ cancelled: cancelJob() }));

// ------------------------------------------------------------------- export

app.get('/api/export.csv', (_req, res) => {
  const investors = getInvestors();
  const answers = read('answers', {});
  const playbook = read('playbook', DEFAULT_PLAYBOOK);
  const columns = [...investors.columns, ...playbook.steps.map((s) => s.name)];
  const records = investors.rows.map((r) => {
    const out = {};
    for (const c of investors.columns) out[c] = r[c];
    for (const s of playbook.steps) out[s.name] = answers[r.__id]?.steps?.[s.id]?.text || '';
    return out;
  });
  res.type('text/csv').attachment('investor-answers.csv').send(toCsv(columns, records));
});

// --------------------------------------------------------------------- boot

if (!fs.existsSync(path.join(ROOT, 'data', 'settings.json'))) {
  write('settings', { ...DEFAULT_SETTINGS, apiKey: process.env.ANTHROPIC_API_KEY || '' });
}
if (!fs.existsSync(path.join(ROOT, 'data', 'playbook.json'))) {
  write('playbook', DEFAULT_PLAYBOOK);
}
seedIfEmpty();

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Investor playbook running at http://localhost:${port}`));
