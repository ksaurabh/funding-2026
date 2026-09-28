import express from 'express';
import * as agent from './agent.js';
import * as contacts from './contacts.js';
import * as network from './network.js';
import * as intro from './intro.js';
import { readRowsMerged } from '../store.js';

export const linkedinRoutes = express.Router();

// The cached pages — screenshots and the markup that produced them.
linkedinRoutes.use('/shots', express.static(agent.SHOTS_DIR, { maxAge: '1h' }));
linkedinRoutes.get('/cache', (_req, res) => res.json({ dir: agent.SHOTS_DIR, files: agent.cachedPages() }));

const fail = (res, err) => res.status(400).json({ error: err.message });

// The page the agent is on at this moment, picture and markup.
linkedinRoutes.post('/capture', async (req, res) => {
  try {
    res.json(await agent.captureCurrent(req.body?.label));
  } catch (err) {
    fail(res, err);
  }
});

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

/**
 * Take one of the search results as the right person, whatever it scored.
 * The confidence bar exists to stop the agent guessing; it should not stop
 * you deciding. Accepting records that candidate and then opens their
 * profile, which reads the degree and follows the mutual connections.
 */
linkedinRoutes.post('/contacts/:id/accept', (req, res) => {
  const c = contacts.all().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found.' });

  const url = req.body?.url;
  const pick = (c.candidates || []).find((x) => x.url === url);
  if (!pick) return res.status(400).json({ error: 'That is not one of the results on record.' });

  contacts.upsert({
    id: c.id,
    name: pick.name,
    url: pick.url,
    headline: pick.headline,
    company: pick.company || c.company,
    degree: pick.degree,
    degreeSource: pick.degree ? 'search result' : null,
    confidence: pick.confidence,
    acceptedBy: 'you',
    status: 'found',
    reason: null,
  });

  // Go and read them properly, which also walks the mutual connections.
  contacts.enqueue([{ name: pick.name, url: pick.url, contactId: c.id }]);
  res.json(contacts.queueStatus());
});

/** Run just the mutual-connections walk for a contact, on request. */
linkedinRoutes.post('/contacts/:id/mutuals', (req, res) => {
  const c = contacts.all().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Contact not found.' });
  if (!c.mutualPage?.link) {
    return res.status(400).json({ error: 'No mutual-connections link was recorded for them.' });
  }
  contacts.enqueue([{ name: c.name, contactId: c.id, mutualsOnly: true }]);
  res.json(contacts.queueStatus());
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

const DEGREES = new Set(['1st', '2nd', '3rd']);

linkedinRoutes.patch('/contacts/:id', (req, res) => {
  // Correcting the degree by hand, when the page did not yield one.
  if ('degree' in (req.body || {})) {
    const { degree } = req.body;
    if (degree !== null && !DEGREES.has(degree)) {
      return res.status(400).json({ error: 'Degree must be 1st, 2nd, 3rd, or null.' });
    }
    const found = contacts.all().find((x) => x.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'Contact not found.' });
    return res.json(
      contacts.upsert({ id: found.id, degree, degreeSource: degree ? 'search result' : null })
    );
  }

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

// ----------------------------------------------------- your own network

linkedinRoutes.get('/network', (_req, res) => res.json(network.all()));

linkedinRoutes.post('/network', (req, res) => {
  // Either one batch with a source, or several — adding everyone that a set
  // of contacts is connected through, each keeping its own attribution.
  const groups = Array.isArray(req.body?.groups)
    ? req.body.groups
    : [{ people: req.body?.people || [], source: req.body?.source || null }];

  const totals = { added: 0, merged: 0, total: 0, from: 0 };
  for (const g of groups) {
    const people = Array.isArray(g?.people) ? g.people : [];
    if (!people.length) continue;
    const r = network.add(people, g.source || null);
    totals.added += r.added;
    totals.merged += r.merged;
    totals.total = r.total;
    totals.from++;
  }
  if (!totals.from) return res.status(400).json({ error: 'Nobody to add.' });
  res.json(totals);
});

linkedinRoutes.patch('/network/:id', (req, res) => {
  const p = network.patch(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'Not in your network.' });
  res.json(p);
});

linkedinRoutes.post('/network/delete', (req, res) =>
  res.json({ removed: network.remove(req.body?.ids || []) })
);

linkedinRoutes.post('/network/refresh-strength', (req, res) =>
  res.json(network.refreshStrength({ overwrite: !!req.body?.overwrite, contacts: contacts.all() }))
);

// Re-derive from lookups already fetched; touches no network.
linkedinRoutes.post('/network/resync', (_req, res) => res.json(network.resyncFrom(contacts.all())));

linkedinRoutes.post('/network/renumber', (req, res) => res.json(network.renumber(req.body?.ids || [])));

linkedinRoutes.get('/network.csv', (_req, res) => {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = ['rank', 'name', 'headline', 'strength', 'url', 'notes', 'introduces to'];
  const lines = [cols.join(',')];
  for (const p of network.all()) {
    lines.push(
      [p.rank, p.name, p.headline, p.strength, p.url, p.notes, (p.sources || []).map((s) => s.name).join('; ')]
        .map(esc)
        .join(',')
    );
  }
  res.type('text/csv').attachment('my-network.csv').send(lines.join('\n'));
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

// ------------------------------------------------------------ ask for an intro

linkedinRoutes.get('/intro', (_req, res) =>
  res.json({
    ...intro.state(),
    cost: intro.totalCost(),
    terms: intro.terms(),
    defaultPrompt: intro.DEFAULT_PROMPT,
    relevance: intro.relevance(),
  })
);

linkedinRoutes.post('/intro/introducers', (req, res) => {
  try {
    res.json({ added: intro.addIntroducer(req.body?.name), ...intro.state() });
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.delete('/intro/introducers/:id', (req, res) => res.json(intro.removeIntroducer(req.params.id)));

// A job is one connection × one term × one prompt.
linkedinRoutes.post('/intro/jobs', (req, res) => {
  try {
    const { connectionName, introducerId, term, prompt, qualify } = req.body || {};
    res.json({ added: intro.addJob({ connectionName, introducerId, term, prompt, qualify }), ...intro.state() });
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.post('/intro/jobs/:id/run', (req, res) => {
  try {
    res.json({ job: intro.runJobAgain(req.params.id, req.body?.prompt), ...intro.state() });
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.delete('/intro/jobs/:id', (req, res) => res.json(intro.removeJob(req.params.id)));

linkedinRoutes.post('/intro/queue/clear', (_req, res) => res.json(intro.clearQueue()));

// Everyone found, across every job, one entry each.
linkedinRoutes.get('/intro/people', (_req, res) =>
  res.json({ people: intro.people(), relevance: intro.relevance(), odds: intro.ODDS })
);

// An email to one connection, asking about the people picked.
linkedinRoutes.post('/intro/email', async (req, res) => {
  try {
    const { introducerName, keys, context } = req.body || {};
    res.json(await intro.draftEmail({ introducerName, keys, context }));
  } catch (err) {
    fail(res, err);
  }
});

// Read and ask about several people at once.
linkedinRoutes.post('/intro/people/qualify', (req, res) => {
  try {
    res.json(intro.qualifyMany(req.body?.rowIds));
  } catch (err) {
    fail(res, err);
  }
});

// How likely each of these people is to be an investor, judged from the title.
linkedinRoutes.post('/intro/people/odds', (req, res) => {
  try {
    res.json(intro.estimateOdds(req.body?.groups));
  } catch (err) {
    fail(res, err);
  }
});

// A mark on a person is a mark on every row that is them.
linkedinRoutes.patch('/intro/people', (req, res) => {
  try {
    const { rowIds, relevance, note } = req.body || {};
    res.json({ row: intro.markPerson(rowIds, { relevance, note }) });
  } catch (err) {
    fail(res, err);
  }
});

linkedinRoutes.get('/intro/people.csv', (_req, res) => {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = [
    'name',
    'title',
    'company',
    'degree',
    'linkedin',
    'connected via',
    'category',
    'investor likelihood',
    'relevance',
    'note',
  ];
  const lines = [cols.join(',')];
  for (const p of intro.people()) {
    lines.push(
      [
        p.name,
        p.title,
        p.company,
        p.degree,
        p.url,
        p.via.map((v) => v.name).join('; '),
        p.answer,
        p.odds,
        p.relevance,
        p.note,
      ]
        .map(esc)
        .join(',')
    );
  }
  res.type('text/csv').attachment('second-degree-connections.csv').send(lines.join('\n'));
});

// Stop the job that is running now, keeping what it has already collected.
linkedinRoutes.post('/intro/stop', (req, res) => res.json(intro.stopCurrent({ all: !!req.body?.all })));

// A relevance option added from the dropdown.
linkedinRoutes.post('/intro/relevance', (req, res) => {
  try {
    res.json(intro.addRelevance(req.body?.value));
  } catch (err) {
    fail(res, err);
  }
});

// Your own call on a row: relevance and a note.
linkedinRoutes.patch('/intro/rows/:id', (req, res) => {
  try {
    const { relevance, note } = req.body || {};
    res.json({ row: intro.markRow(req.params.id, { relevance, note }) });
  } catch (err) {
    fail(res, err);
  }
});

// Re-ask the model about one row, usually after rewording the prompt.
linkedinRoutes.post('/intro/rows/:id/ask', async (req, res) => {
  try {
    res.json({ row: await intro.reask(req.params.id, req.body?.prompt), ...intro.state() });
  } catch (err) {
    fail(res, err);
  }
});

// What exactly was put to the model for one row.
linkedinRoutes.get('/intro/rows/:id/prompt', (req, res) => {
  const row = intro.state().rows.find((r) => r.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'No such row.' });
  res.json({ prompt: intro.renderPrompt(row.prompt || intro.state().prompt, row), profile: intro.profileBlock(row) });
});

linkedinRoutes.get('/intro.csv', (_req, res) => {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = [
    'term',
    'introducer',
    'name',
    'title',
    'company',
    'degree',
    'linkedin',
    'category',
    'relevance',
    'note',
    'already checked via',
  ];
  const lines = [cols.join(',')];
  for (const r of intro.state().rows) {
    lines.push(
      [
        r.term,
        r.introducerName,
        r.name,
        r.title || r.headline,
        r.company,
        r.degree,
        r.url,
        r.answer || r.error,
        r.relevance || intro.RELEVANCE[0],
        r.note || '',
        r.carriedFrom?.introducerName || '',
      ]
        .map(esc)
        .join(',')
    );
  }
  res.type('text/csv').attachment('ask-for-intro.csv').send(lines.join('\n'));
});
