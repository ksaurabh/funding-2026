import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { csvToRecords, toCsv } from './csv.js';
import {
  read,
  write,
  exists,
  readRowsMerged,
  readSchema,
  findField,
  writeCell,
  removeList,
  listFile,
  ROOT,
  DEFAULT_SETTINGS,
  DEFAULT_PLAYBOOK,
  SAMPLE_STEPS,
} from './store.js';
import { startRun, jobStatus, cancelJob, renderTemplate, slugify } from './runner.js';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ------------------------------------------------------------------ helpers

const getLists = () => read('lists', []);

function findList(id) {
  const list = getLists().find((l) => l.id === id);
  if (!list) {
    const err = new Error('List not found.');
    err.status = 404;
    throw err;
  }
  return list;
}

function rowId(row, columns, index) {
  const name = String(row[columns[0]] ?? '').trim();
  if (!name) return `row_${index}`;
  return crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12);
}

/** Parse CSV text into a list's investors file. Returns {columns, rows}. */
function parseInvestors(text) {
  const { columns, records } = csvToRecords(text);
  if (!columns.length) throw new Error('That CSV has no header row.');
  if (!records.length) throw new Error('That CSV has a header but no rows.');
  const seen = new Set();
  const rows = records.map((r, i) => {
    let id = rowId(r, columns, i);
    while (seen.has(id)) id = id + '_' + i;
    seen.add(id);
    return { __id: id, ...r };
  });
  return { columns, rows };
}

function createList({ name, csv, source, steps }) {
  const id = crypto.randomUUID().slice(0, 8);
  const investors = parseInvestors(csv);
  write(listFile(id, 'investors'), investors);
  write(listFile(id, 'playbook'), { ...DEFAULT_PLAYBOOK, steps: steps || [] });
  write(listFile(id, 'answers'), {});
  const entry = {
    id,
    name: (name || source || 'Untitled list').trim(),
    source: source || null,
    columns: investors.columns,
    rowCount: investors.rows.length,
    createdAt: new Date().toISOString(),
  };
  write('lists', [...getLists(), entry]);
  return entry;
}

/** Answered/total counts for a list, used on the lists index. */
function listStats(id) {
  const playbook = read(listFile(id, 'playbook'), DEFAULT_PLAYBOOK);
  const answers = read(listFile(id, 'answers'), {});
  const investors = read(listFile(id, 'investors'), { rows: [] });
  const enabled = playbook.steps.filter((s) => s.enabled !== false);
  let answered = 0;
  let errors = 0;
  let lastRun = null;
  for (const r of investors.rows) {
    const entry = answers[r.__id];
    if (!entry) continue;
    if (enabled.length && enabled.every((s) => entry.steps?.[s.id]?.text)) answered++;
    if (enabled.some((s) => entry.steps?.[s.id]?.error)) errors++;
    if (entry.updatedAt && (!lastRun || entry.updatedAt > lastRun)) lastRun = entry.updatedAt;
  }
  return { stepCount: enabled.length, answered, errors, lastRun };
}

// -------------------------------------------------------------------- lists

app.get('/api/lists', (_req, res) => {
  res.json(getLists().map((l) => ({ ...l, ...listStats(l.id) })));
});

app.post('/api/lists', (req, res) => {
  try {
    const { csv, name, source } = req.body || {};
    if (!csv) return res.status(400).json({ error: 'No CSV content received.' });
    res.json(createList({ csv, name, source }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/lists/:id', (req, res) => {
  const lists = getLists();
  const list = lists.find((l) => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found.' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) list.name = req.body.name.trim();
  write('lists', lists);
  res.json(list);
});

app.delete('/api/lists/:id', (req, res) => {
  const status = jobStatus();
  if (status.running && status.listId === req.params.id) {
    return res.status(409).json({ error: 'That list is being researched right now. Cancel the run first.' });
  }
  write('lists', getLists().filter((l) => l.id !== req.params.id));
  removeList(req.params.id);
  res.json({ ok: true });
});

// Replace a list's rows from a new CSV, keeping answers for rows that survive.
app.post('/api/lists/:id/reimport', (req, res) => {
  try {
    const list = findList(req.params.id);
    const investors = parseInvestors(req.body?.csv || '');
    write(listFile(list.id, 'investors'), investors);

    // Drop config for CSV columns the new file no longer has; columns added
    // here survive a re-import, as do their values.
    const schema = readSchema(list.id);
    const kept = schema.fields.filter((f) => f.custom || investors.columns.includes(f.name));
    if (kept.length !== schema.fields.length) write(listFile(list.id, 'schema'), { fields: kept });

    const lists = getLists();
    Object.assign(
      lists.find((l) => l.id === list.id),
      { columns: investors.columns, rowCount: investors.rows.length, source: req.body?.source || list.source }
    );
    write('lists', lists);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ----------------------------------------------------------------- settings

app.get('/api/settings', (_req, res) => {
  const s = { ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) };
  res.json({
    ...s,
    apiKey: undefined,
    apiKeySet: !!s.apiKey,
    apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '',
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

app.get('/api/lists/:listId/playbook', (req, res) => {
  try {
    findList(req.params.listId);
    res.json(read(listFile(req.params.listId, 'playbook'), DEFAULT_PLAYBOOK));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.put('/api/lists/:listId/playbook', (req, res) => {
  try {
    findList(req.params.listId);
    const body = req.body || {};
    const steps = (body.steps || []).map((s, i) => ({
      id: s.id || crypto.randomUUID(),
      name: (s.name || `Step ${i + 1}`).trim(),
      key: slugify(s.key || s.name || `step_${i + 1}`),
      prompt: s.prompt || '',
      webSearch: !!s.webSearch,
      enabled: s.enabled !== false,
      // Column this step's answer fills in, if any.
      writeTo: String(s.writeTo || '').trim(),
    }));
    const playbook = {
      system: body.system ?? DEFAULT_PLAYBOOK.system,
      mode: body.mode === 'independent' ? 'independent' : 'conversation',
      steps,
    };
    write(listFile(req.params.listId, 'playbook'), playbook);
    res.json(playbook);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Copy another list's playbook into this one (fresh step ids, no answers move).
app.post('/api/lists/:listId/playbook/copy-from/:sourceId', (req, res) => {
  try {
    findList(req.params.listId);
    findList(req.params.sourceId);
    const source = read(listFile(req.params.sourceId, 'playbook'), DEFAULT_PLAYBOOK);
    const playbook = {
      ...source,
      steps: source.steps.map((s) => ({ ...s, id: crypto.randomUUID() })),
    };
    write(listFile(req.params.listId, 'playbook'), playbook);
    res.json(playbook);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Render a step's prompt against one row, without calling the model.
app.post('/api/lists/:listId/playbook/preview', (req, res) => {
  const investors = readRowsMerged(req.params.listId);
  const row = investors.rows.find((r) => r.__id === req.body?.investorId) || investors.rows[0];
  if (!row) return res.status(400).json({ error: 'This list has no rows.' });
  res.json(renderTemplate(req.body?.prompt, row, {}));
});

// ------------------------------------------------------------------- schema
// Editable columns come in two flavours: a CSV column turned editable, and a
// column added here (its values live only in edits.json). Both are either free
// text or a dropdown of allowed values.

const MAX_CHOICES = 200;
const TYPES = new Set(['text', 'enum']);

function distinctValues(rows, column) {
  const seen = new Map();
  for (const r of rows) {
    const v = String(r[column] ?? '').trim();
    if (!v) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
    if (seen.size > MAX_CHOICES) return null; // too free-text to be a dropdown
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

function cleanValues(values) {
  const out = [];
  for (const v of values || []) {
    const t = String(v).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_CHOICES);
}

app.get('/api/lists/:listId/schema', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const { columns, rows, schema } = readRowsMerged(list.id);
    res.json({
      fields: schema.fields,
      candidates: columns.map((name) => {
        const distinct = distinctValues(rows, name);
        return {
          name,
          distinct: distinct || [],
          tooMany: distinct === null,
          blanks: rows.filter((r) => !String(r[name] ?? '').trim()).length,
        };
      }),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.put('/api/lists/:listId/schema', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const { columns } = read(listFile(list.id, 'investors'), { columns: [] });
    const csvColumns = new Set(columns);

    const fields = [];
    for (const f of req.body?.fields || []) {
      const name = String(f?.name ?? '').trim();
      if (!name || fields.some((x) => x.name === name)) continue;
      const custom = !csvColumns.has(name);
      const type = TYPES.has(f.type) ? f.type : 'text';
      fields.push({
        name,
        // A CSV column is only worth making editable as a dropdown; free-text
        // editing of imported data is what a re-import is for.
        type: custom ? type : 'enum',
        values: type === 'enum' || !custom ? cleanValues(f.values) : [],
        custom,
      });
    }
    if (fields.length > 60) throw new Error('Too many editable columns.');

    // Forget cell values for columns that no longer exist.
    const live = new Set([...csvColumns, ...fields.map((f) => f.name)]);
    const editKey = listFile(list.id, 'edits');
    const edits = read(editKey, {});
    let pruned = false;
    for (const [rowId, patch] of Object.entries(edits)) {
      for (const col of Object.keys(patch)) {
        if (!live.has(col)) {
          delete patch[col];
          pruned = true;
        }
      }
      if (!Object.keys(patch).length) delete edits[rowId];
    }
    if (pruned) write(editKey, edits);

    res.json(write(listFile(list.id, 'schema'), { fields }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Set one cell of one row. A dropdown value that is not yet in the column's
// choice list is added to it, so the list grows as you use it.
app.patch('/api/lists/:listId/investors/:id', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const { columns, rows } = read(listFile(list.id, 'investors'), { columns: [], rows: [] });
    const schema = readSchema(list.id);
    const column = req.body?.column;
    const field = findField(schema, column);

    if (!field && !columns.includes(column)) return res.status(400).json({ error: 'Unknown column.' });
    if (!field) return res.status(400).json({ error: 'That column is not editable.' });
    if (!rows.some((r) => r.__id === req.params.id)) {
      return res.status(404).json({ error: 'Row not found.' });
    }

    const value = String(req.body?.value ?? '').trim();
    writeCell(list.id, req.params.id, column, value);

    if (field.type === 'enum' && value && !field.values.includes(value)) {
      field.values = [...field.values, value].slice(0, MAX_CHOICES);
      write(listFile(list.id, 'schema'), schema);
    }

    res.json({ ok: true, value, fields: schema.fields });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- investors

app.get('/api/lists/:listId/investors', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const investors = readRowsMerged(list.id);
    const answers = read(listFile(list.id, 'answers'), {});
    const playbook = read(listFile(list.id, 'playbook'), DEFAULT_PLAYBOOK);
    const enabled = playbook.steps.filter((s) => s.enabled !== false);

    const rows = investors.rows.map((r) => {
      const entry = answers[r.__id];
      return {
        ...r,
        __done: enabled.filter((s) => entry?.steps?.[s.id]?.text).length,
        __errors: enabled.filter((s) => entry?.steps?.[s.id]?.error).length,
        __updatedAt: entry?.updatedAt || null,
      };
    });

    res.json({
      list,
      columns: investors.allColumns,
      csvColumns: investors.columns,
      rows,
      stepCount: enabled.length,
      schema: investors.schema,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/lists/:listId/investors/:id', (req, res) => {
  const investors = readRowsMerged(req.params.listId);
  const row = investors.rows.find((r) => r.__id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Investor not found.' });
  const playbook = read(listFile(req.params.listId, 'playbook'), DEFAULT_PLAYBOOK);
  const entry = read(listFile(req.params.listId, 'answers'), {})[req.params.id] || { steps: {} };
  res.json({
    investor: row,
    columns: investors.allColumns,
    schema: investors.schema,
    steps: playbook.steps.map((s) => ({ ...s, answer: entry.steps?.[s.id] || null })),
    updatedAt: entry.updatedAt || null,
  });
});

app.delete('/api/lists/:listId/investors/:id/answers', (req, res) => {
  const key = listFile(req.params.listId, 'answers');
  const answers = read(key, {});
  delete answers[req.params.id];
  write(key, answers);
  res.json({ ok: true });
});

// --------------------------------------------------------------------- runs

app.post('/api/lists/:listId/run', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const investors = readRowsMerged(list.id);
    const body = req.body || {};
    let ids = body.investorIds;

    if (body.scope === 'all' || !ids) ids = investors.rows.map((r) => r.__id);
    if (body.scope === 'unanswered') {
      const answers = read(listFile(list.id, 'answers'), {});
      const playbook = read(listFile(list.id, 'playbook'), DEFAULT_PLAYBOOK);
      const enabled = playbook.steps.filter((s) => s.enabled !== false);
      ids = investors.rows
        .filter((r) => enabled.some((s) => !answers[r.__id]?.steps?.[s.id]?.text))
        .map((r) => r.__id);
    }

    res.json(startRun({ listId: list.id, listName: list.name, investorIds: ids, stepIds: body.stepIds }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/run/status', (_req, res) => res.json(jobStatus()));
app.post('/api/run/cancel', (_req, res) => res.json({ cancelled: cancelJob() }));

// ------------------------------------------------------------------- export

app.get('/api/lists/:listId/export.csv', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const investors = readRowsMerged(list.id);
    const answers = read(listFile(list.id, 'answers'), {});
    const playbook = read(listFile(list.id, 'playbook'), DEFAULT_PLAYBOOK);
    // The list itself, then the raw answer text of each step alongside it.
    const stepColumns = playbook.steps.map((s) => `${s.name} (answer)`);
    const columns = [...investors.allColumns, ...stepColumns];
    const records = investors.rows.map((r) => {
      const out = {};
      for (const c of investors.allColumns) out[c] = r[c];
      playbook.steps.forEach((s, i) => {
        out[stepColumns[i]] = answers[r.__id]?.steps?.[s.id]?.text || '';
      });
      return out;
    });
    const slug = list.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list';
    res.type('text/csv').attachment(`${slug}-answers.csv`).send(toCsv(columns, records));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// --------------------------------------------------------------------- boot

function bootstrap() {
  if (!exists('settings')) {
    write('settings', { ...DEFAULT_SETTINGS, apiKey: process.env.ANTHROPIC_API_KEY || '' });
  }
  if (!exists('lists')) write('lists', []);

  // Migrate the pre-multi-list layout (data/{investors,playbook,answers}.json).
  if (exists('investors') && !getLists().length) {
    const old = read('investors', { columns: [], rows: [] });
    if (old.rows.length) {
      const entry = createList({
        name: old.source || 'Imported list',
        source: old.source,
        csv: toCsv(old.columns, old.rows),
      });
      if (exists('playbook')) write(listFile(entry.id, 'playbook'), read('playbook', DEFAULT_PLAYBOOK));
      if (exists('answers')) write(listFile(entry.id, 'answers'), read('answers', {}));
      console.log(`Migrated existing data into list "${entry.name}".`);
    }
    for (const f of ['investors', 'playbook', 'answers']) {
      const p = path.join(ROOT, 'data', f + '.json');
      if (fs.existsSync(p)) fs.renameSync(p, p + '.migrated');
    }
  }

  // First run with nothing at all: seed from the CSV shipped next to the app.
  if (!getLists().length) {
    const seed = path.join(ROOT, 'funding-round-investors.csv');
    if (fs.existsSync(seed)) {
      const entry = createList({
        name: 'Cybersecurity lead investors',
        source: 'funding-round-investors.csv',
        csv: fs.readFileSync(seed, 'utf8'),
        steps: SAMPLE_STEPS,
      });
      console.log(`Seeded list "${entry.name}" from funding-round-investors.csv`);
    }
  }
}

bootstrap();

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Investor playbook running at http://localhost:${port}`));
