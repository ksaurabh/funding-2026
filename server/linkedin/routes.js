import express from 'express';
import * as agent from './agent.js';
import * as contacts from './contacts.js';
import { readRowsMerged } from '../store.js';

export const linkedinRoutes = express.Router();

// The cached pages — screenshots and the markup that produced them.
linkedinRoutes.use('/shots', express.static(agent.SHOTS_DIR, { maxAge: '1h' }));
linkedinRoutes.get('/cache', (_req, res) => res.json({ dir: agent.SHOTS_DIR, files: agent.cachedPages() }));

const fail = (res, err) => res.status(400).json({ error: err.message });

// ----------------------------------------------------------------- session

linkedinRoutes.get('/session', async (_req, res) => {
  try {
    res.json(await agent.status());
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.post('/session/start', async (_req, res) => {
  try {
    res.json(await agent.openSession());
  } catch (err) {
    fail(res, err);
  }
});

// Held open until you finish signing in, so the UI can just wait.
linkedinRoutes.post('/session/wait-login', async (_req, res) => {
  try {
    res.json(await agent.waitForLogin());
  } catch (err) {
    fail(res, err);
  }
});

// "I'm already signed in" — look again rather than keep waiting.
linkedinRoutes.post('/session/recheck', async (_req, res) => {
  try {
    const s = await agent.recheck();
    if (s.loggedIn) contacts.resumeQueue();
    res.json(s);
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.post('/session/stop', async (_req, res) => {
  try {
    res.json(await agent.closeSession());
  } catch (err) {
    fail(res, err);
  }
});

// ----------------------------------------------------------------- lookups

linkedinRoutes.get('/queue', (_req, res) => res.json(contacts.queueStatus()));

linkedinRoutes.post('/lookup', (req, res) => {
  try {
    const items = Array.isArray(req.body?.people) ? req.body.people : [req.body];
    const n = contacts.enqueue(items);
    if (!n) return res.status(400).json({ error: 'Nothing to look up — a name is required.' });
    res.json({ queued: n, ...contacts.queueStatus() });
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.post('/queue/clear', (_req, res) => res.json({ dropped: contacts.clearQueue() }));
linkedinRoutes.post('/queue/resume', (_req, res) => res.json(contacts.resumeQueue()));

/** Queue everyone named in two columns of a list, skipping blanks and repeats. */
linkedinRoutes.post('/lookup-from-list', (req, res) => {
  try {
    const { listId, nameColumn, companyColumn, investorIds } = req.body || {};
    const { rows } = readRowsMerged(listId);
    const wanted = investorIds?.length ? rows.filter((r) => investorIds.includes(r.__id)) : rows;

    const seen = new Set(contacts.all().map((c) => `${c.queriedAs || c.name}|${c.company}`.toLowerCase()));
    const people = [];
    for (const r of wanted) {
      const name = String(r[nameColumn] ?? '').trim();
      if (!name) continue;
      const company = String(r[companyColumn] ?? '').trim();
      const key = `${name}|${company}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({ name, company });
    }
    const n = contacts.enqueue(people);
    res.json({ queued: n, skipped: wanted.length - n });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------- contacts

linkedinRoutes.get('/contacts', (_req, res) => res.json(contacts.all()));

linkedinRoutes.patch('/contacts/:id', (req, res) => {
  const c = contacts.patch(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  res.json(c);
});

linkedinRoutes.delete('/contacts/:id', (req, res) => {
  res.json({ removed: contacts.remove(req.params.id) });
});

/** Several at once, and everything, from the contacts table. */
linkedinRoutes.post('/contacts/delete', (req, res) => {
  const ids = req.body?.all ? contacts.all().map((c) => c.id) : req.body?.ids || [];
  res.json({ removed: contacts.remove(ids) });
});

linkedinRoutes.get('/contacts.csv', (_req, res) => {
  const rows = contacts.all();
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = ['name', 'company', 'headline', 'degree', 'url', 'strength', 'notes', 'status', 'confidence', 'via'];
  const lines = [cols.join(',')];
  for (const c of rows) {
    lines.push(
      cols
        .map((k) => esc(k === 'via' ? (c.via || []).map((v) => v.name).join('; ') : c[k]))
        .join(',')
    );
  }
  res.type('text/csv').attachment('linkedin-contacts.csv').send(lines.join('\n'));
});
