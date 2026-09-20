import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { csvToRecords, toCsv } from './csv.js';
import {
  MAX_AUTO_FILTER,
  read,
  write,
  exists,
  readRowsMerged,
  readSchema,
  defaultField,
  findField,
  writeCell,
  removeList,
  removeFile,
  listFile,
  playbookFile,
  ROOT,
  DEFAULT_SETTINGS,
  DEFAULT_PLAYBOOK,
  SAMPLE_STEPS,
} from './store.js';
import { startRun, jobStatus, cancelJob, renderTemplate, slugify } from './runner.js';
import { linkedinRoutes } from './linkedin/routes.js';
import { costOf, knownModel } from './pricing.js';

const app = express();
app.use(express.json({ limit: '50mb' }));
// Always revalidate: a browser holding an old app.js against a new server is
// a confusing class of bug, and locally a 304 costs nothing.
app.use(
  express.static(path.join(ROOT, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

app.use('/api/linkedin', linkedinRoutes);

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

const getPlaybooks = () => read('playbooks', []);

/** The playbook a list is pointing at, or an empty one if it has none. */
function playbookOf(listId) {
  const list = getLists().find((l) => l.id === listId);
  if (!list?.playbookId) return { ...DEFAULT_PLAYBOOK, id: null, steps: [] };
  const pb = read(playbookFile(list.playbookId), null);
  if (!pb) return { ...DEFAULT_PLAYBOOK, id: null, steps: [] };
  return pb;
}

function normaliseSteps(steps) {
  return (steps || []).map((s, i) => ({
    id: s.id || crypto.randomUUID(),
    name: (s.name || `Step ${i + 1}`).trim(),
    key: slugify(s.key || s.name || `step_${i + 1}`),
    prompt: s.prompt || '',
    webSearch: !!s.webSearch,
    enabled: s.enabled !== false,
    // Left out of ordinary runs; only runs when asked for by name.
    manual: !!s.manual,
    // Column this step's answer fills in, if any.
    writeTo: String(s.writeTo || '').trim(),
  }));
}

function savePlaybook(id, body) {
  const pb = {
    id,
    name: (body.name || 'Untitled playbook').trim() || 'Untitled playbook',
    system: body.system ?? DEFAULT_PLAYBOOK.system,
    mode: body.mode === 'independent' ? 'independent' : 'conversation',
    steps: normaliseSteps(body.steps),
  };
  write(playbookFile(id), pb);
  const index = getPlaybooks();
  const row = index.find((p) => p.id === id);
  if (row) row.name = pb.name;
  else index.push({ id, name: pb.name, createdAt: new Date().toISOString() });
  write('playbooks', index);
  return pb;
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

function createList({ name, csv, source, steps, playbookName }) {
  const id = crypto.randomUUID().slice(0, 8);
  const investors = parseInvestors(csv);
  write(listFile(id, 'investors'), investors);
  write(listFile(id, 'answers'), {});

  // A new list starts with no playbook unless one is seeded alongside it.
  let playbookId = null;
  if (steps?.length) {
    playbookId = savePlaybook(crypto.randomUUID().slice(0, 8), {
      name: playbookName || `${name || source || 'Untitled'} playbook`,
      steps,
    }).id;
  }

  const entry = {
    id,
    name: (name || source || 'Untitled list').trim(),
    source: source || null,
    playbookId,
    columns: investors.columns,
    rowCount: investors.rows.length,
    createdAt: new Date().toISOString(),
  };
  write('lists', [...getLists(), entry]);
  return entry;
}

/** Answered/total counts for a list, used on the lists index. */
/** The steps an ordinary run covers: enabled, and not manual-only. */
const automaticSteps = (playbook) => playbook.steps.filter((s) => s.enabled !== false && !s.manual);

function listStats(id) {
  const playbook = playbookOf(id);
  const answers = read(listFile(id, 'answers'), {});
  const investors = read(listFile(id, 'investors'), { rows: [] });
  const enabled = automaticSteps(playbook);
  let answered = 0;
  let errors = 0;
  let lastRun = null;
  let cost = 0;
  let costUnknown = false;
  let calls = 0;
  for (const r of investors.rows) {
    const entry = answers[r.__id];
    if (!entry) continue;
    if (enabled.length && enabled.every((s) => entry.steps?.[s.id]?.text)) answered++;
    if (enabled.some((s) => entry.steps?.[s.id]?.error)) errors++;
    if (entry.updatedAt && (!lastRun || entry.updatedAt > lastRun)) lastRun = entry.updatedAt;
    // Every step ever run counts, including ones from a playbook since changed.
    for (const rec of Object.values(entry.steps || {})) {
      if (!rec.usage) continue;
      calls++;
      cost += rec.cost || 0;
      if (rec.costUnknown) costUnknown = true;
    }
  }
  return {
    stepCount: enabled.length,
    playbookName: playbook.id ? playbook.name : null,
    answered,
    errors,
    lastRun,
    cost,
    costUnknown,
    calls,
  };
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
  // Which columns hold a person and their firm, so a LinkedIn lookup from a
  // row is one click after the first time.
  if (req.body?.linkedin) {
    list.linkedin = {
      nameColumn: String(req.body.linkedin.nameColumn || '').trim(),
      companyColumn: String(req.body.linkedin.companyColumn || '').trim(),
    };
  }
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
    // Settings for imported columns the new file lacks are dropped; columns
    // added here survive a re-import, as do their values.
    const schema = readSchema(list.id, investors.columns);
    const kept = Object.fromEntries(
      Object.entries(schema.fields).filter(([name, f]) => f.custom || investors.columns.includes(name))
    );
    write(listFile(list.id, 'schema'), {
      fields: kept,
      order: schema.order.filter((n) => kept[n]),
    });
    pruneEdits(list.id, new Set(Object.keys(kept)));

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

// ---------------------------------------------------------------- playbooks
// Playbooks are named and saved once, then attached to any number of lists.

app.get('/api/playbooks', (_req, res) => {
  const lists = getLists();
  res.json(
    getPlaybooks().map((p) => {
      const pb = read(playbookFile(p.id), { steps: [] });
      return {
        ...p,
        mode: pb.mode,
        stepCount: pb.steps.length,
        usedBy: lists.filter((l) => l.playbookId === p.id).map((l) => ({ id: l.id, name: l.name })),
      };
    })
  );
});

app.post('/api/playbooks', (req, res) => {
  try {
    const body = req.body || {};
    const source = body.copyFrom ? read(playbookFile(body.copyFrom), null) : null;
    const pb = savePlaybook(crypto.randomUUID().slice(0, 8), {
      name: body.name || (source ? `${source.name} (copy)` : 'New playbook'),
      system: body.system ?? source?.system,
      mode: body.mode ?? source?.mode,
      // A copy gets fresh step ids so its answers stay separate from the original's.
      steps: (body.steps ?? source?.steps ?? []).map((s) => ({ ...s, id: undefined })),
    });
    // Optionally attach it to a list in the same call.
    if (body.attachTo) {
      const lists = getLists();
      const list = lists.find((l) => l.id === body.attachTo);
      if (list) {
        list.playbookId = pb.id;
        write('lists', lists);
      }
    }
    res.json(pb);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/playbooks/:id', (req, res) => {
  const pb = read(playbookFile(req.params.id), null);
  if (!pb) return res.status(404).json({ error: 'Playbook not found.' });
  res.json(pb);
});

app.put('/api/playbooks/:id', (req, res) => {
  try {
    if (!read(playbookFile(req.params.id), null)) {
      return res.status(404).json({ error: 'Playbook not found.' });
    }
    res.json(savePlaybook(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/playbooks/:id', (req, res) => {
  const used = getLists().filter((l) => l.playbookId === req.params.id);
  if (used.length) {
    return res.status(409).json({
      error: `Still in use by ${used.map((l) => `"${l.name}"`).join(', ')}. Switch those lists to another playbook first.`,
    });
  }
  write('playbooks', getPlaybooks().filter((p) => p.id !== req.params.id));
  removeFile(playbookFile(req.params.id));
  res.json({ ok: true });
});

// ------------------------------------------------- a list and its playbook

// The playbook this list is using (resolved), plus what else is available.
app.get('/api/lists/:listId/playbook', (req, res) => {
  try {
    const list = findList(req.params.listId);
    res.json(playbookOf(list.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Edits write through to the saved playbook, so every list using it sees them.
app.put('/api/lists/:listId/playbook', (req, res) => {
  try {
    const list = findList(req.params.listId);
    if (!list.playbookId) return res.status(400).json({ error: 'This list has no playbook attached.' });
    res.json(savePlaybook(list.playbookId, { ...req.body, name: req.body?.name || playbookOf(list.id).name }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/lists/:listId/playbook/attach', (req, res) => {
  try {
    const lists = getLists();
    const list = lists.find((l) => l.id === req.params.listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    const id = req.body?.playbookId || null;
    if (id && !read(playbookFile(id), null)) return res.status(404).json({ error: 'Playbook not found.' });
    list.playbookId = id;
    write('lists', lists);
    res.json(playbookOf(list.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
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
// Every column is editable free text by default. A column can be switched to
// a dropdown of allowed values, renamed, hidden from the table, or added here
// outright (in which case its values live only in edits.json).

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
    const { allColumns, columns, rows, schema } = readRowsMerged(list.id);
    res.json({
      fields: schema.fields,
      order: allColumns,
      columns: allColumns.map((name) => {
        const distinct = distinctValues(rows, name);
        return {
          name,
          imported: columns.includes(name),
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
    const imported = new Set(columns);

    const fields = {};
    for (const [rawName, f] of Object.entries(req.body?.fields || {})) {
      // An imported column keeps its name verbatim, even a blank one — some
      // spreadsheets export those, and dropping it here would lose its
      // settings on every save. A column added here must be named.
      const name = imported.has(rawName) ? rawName : String(rawName).trim();
      if (!imported.has(name) && !name) continue;
      const custom = !imported.has(name);
      const type = TYPES.has(f?.type) ? f.type : 'text';
      const editable = custom ? f?.editable !== false : !!f?.editable;
      // Choices are kept even while read-only, so toggling back is lossless.
      const values = type === 'enum' ? cleanValues(f?.values) : [];
      fields[name] = {
        editable,
        type,
        values,
        filter:
          f?.filter === undefined ? type === 'enum' && values.length <= MAX_AUTO_FILTER : !!f.filter,
        // Pixels, clamped to something a person can actually drag back.
        width: f?.width ? Math.max(60, Math.min(800, Math.round(Number(f.width)))) || null : null,
        custom,
        show: f?.show !== false,
      };
    }
    if (Object.keys(fields).length > 80) throw new Error('Too many columns.');

    // Column order, as the list is displayed and downloaded.
    const order = [];
    for (const n of req.body?.order || []) if (fields[n] && !order.includes(n)) order.push(n);
    for (const n of Object.keys(fields)) if (!order.includes(n)) order.push(n);

    // Forget cell values for added columns that are gone.
    const live = new Set([...imported, ...Object.keys(fields)]);
    pruneEdits(list.id, live);

    res.json(write(listFile(list.id, 'schema'), { fields, order }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

function pruneEdits(listId, live) {
  const editKey = listFile(listId, 'edits');
  const edits = read(editKey, {});
  let changed = false;
  for (const [rowId, patch] of Object.entries(edits)) {
    for (const col of Object.keys(patch)) {
      if (!live.has(col)) {
        delete patch[col];
        changed = true;
      }
    }
    if (!Object.keys(patch).length) {
      delete edits[rowId];
      changed = true;
    }
  }
  if (changed) write(editKey, edits);
}

// Rename a column, in the imported rows, the cell values and the settings.
// Playbooks used only by this list have their prompts and targets updated too;
// shared ones are reported back instead of being rewritten behind your back.
app.post('/api/lists/:listId/columns/rename', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const from = String(req.body?.from ?? '');
    const to = String(req.body?.to ?? '').trim();
    if (!to) return res.status(400).json({ error: 'The new name cannot be empty.' });
    if (to === from) return res.json({ ok: true, warnings: [] });

    const investorKey = listFile(list.id, 'investors');
    const investors = read(investorKey, { columns: [], rows: [] });
    const schema = readSchema(list.id, investors.columns);
    if (!schema.fields[from]) return res.status(404).json({ error: 'No such column.' });
    if (schema.fields[to]) return res.status(400).json({ error: 'This list already has a column with that name.' });

    // Imported rows: rebuild each row so the column keeps its position.
    if (investors.columns.includes(from)) {
      investors.columns = investors.columns.map((c) => (c === from ? to : c));
      investors.rows = investors.rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k === from ? to : k, v]))
      );
      write(investorKey, investors);
      const lists = getLists();
      Object.assign(lists.find((l) => l.id === list.id), { columns: investors.columns });
      write('lists', lists);
    }

    const editKey = listFile(list.id, 'edits');
    const edits = read(editKey, {});
    for (const patch of Object.values(edits)) {
      if (from in patch) {
        patch[to] = patch[from];
        delete patch[from];
      }
    }
    write(editKey, edits);

    const fields = {};
    for (const [name, f] of Object.entries(schema.fields)) fields[name === from ? to : name] = f;
    write(listFile(list.id, 'schema'), {
      fields,
      order: schema.order.map((n) => (n === from ? to : n)),
    });

    // The LinkedIn lookup remembers which columns hold the person and their
    // firm by name, so a rename has to move those too.
    const lists2 = getLists();
    const row = lists2.find((l) => l.id === list.id);
    if (row?.linkedin) {
      let moved = false;
      for (const key of ['nameColumn', 'companyColumn']) {
        if (row.linkedin[key] === from) {
          row.linkedin[key] = to;
          moved = true;
        }
      }
      if (moved) write('lists', lists2);
    }

    res.json({ ok: true, warnings: renamePlaybookRefs(list, from, to) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/** Point this list's own playbooks at the new name; flag shared ones. */
function renamePlaybookRefs(list, from, to) {
  const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  const token = new RegExp(`\\{\\{\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi');
  const lists = getLists();
  const warnings = [];

  for (const p of getPlaybooks()) {
    const pb = read(playbookFile(p.id), null);
    if (!pb) continue;
    const uses = pb.steps.some((s) => norm(s.writeTo) === norm(from) || token.test(s.prompt));
    token.lastIndex = 0;
    if (!uses) continue;

    const others = lists.filter((l) => l.playbookId === p.id && l.id !== list.id);
    if (others.length) {
      warnings.push(
        `"${pb.name}" still refers to "${from}" — it is shared with ${others
          .map((l) => `"${l.name}"`)
          .join(', ')}, so it was left alone.`
      );
      continue;
    }
    pb.steps = pb.steps.map((s) => ({
      ...s,
      writeTo: norm(s.writeTo) === norm(from) ? to : s.writeTo,
      prompt: s.prompt.replace(token, `{{${to}}}`),
    }));
    write(playbookFile(p.id), pb);
  }
  return warnings;
}

// Set one cell of one row. A dropdown value that is not yet in the column's
// choice list is added to it, so the list grows as you use it.
app.patch('/api/lists/:listId/investors/:id', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const { columns, rows } = read(listFile(list.id, 'investors'), { columns: [], rows: [] });
    const schema = readSchema(list.id, columns);
    const column = req.body?.column;
    const field = findField(schema, column);

    if (!field) return res.status(400).json({ error: 'Unknown column.' });
    if (!field.editable) return res.status(400).json({ error: `"${column}" is not an editable column.` });
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
    const playbook = playbookOf(list.id);
    const enabled = automaticSteps(playbook);

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
  const playbook = playbookOf(req.params.listId);
  const entry = read(listFile(req.params.listId, 'answers'), {})[req.params.id] || { steps: {} };
  res.json({
    investor: row,
    columns: investors.allColumns,
    schema: investors.schema,
    steps: playbook.steps.map((s) => ({ ...s, answer: entry.steps?.[s.id] || null })),
    updatedAt: entry.updatedAt || null,
  });
});

// Exactly what went to the model for one step, rebuilt from what was stored
// when it ran: the system prompt, the thread it was sent with, and everything
// the model then read on its own. Nothing is duplicated into answers.json —
// the thread is reassembled from the prompts and answers already there.
app.get('/api/lists/:listId/investors/:id/steps/:stepId/request', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const playbook = playbookOf(list.id);
    const entry = read(listFile(list.id, 'answers'), {})[req.params.id];
    const record = entry?.steps?.[req.params.stepId];
    if (!record) return res.status(404).json({ error: 'That step has not run for this row.' });

    const messages = [];
    for (const priorId of record.context || []) {
      const prior = entry.steps[priorId];
      if (!prior) continue;
      messages.push({ role: 'user', content: prior.prompt, stepName: prior.stepName });
      messages.push({ role: 'assistant', content: prior.text, stepName: prior.stepName });
    }
    messages.push({ role: 'user', content: record.prompt, stepName: record.stepName, current: true });

    const promptChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0) + (playbook.system?.length || 0);
    const searchChars = (record.searches || []).reduce((n, s) => n + (s.chars || 0), 0);

    res.json({
      stepName: record.stepName,
      model: record.model,
      mode: record.mode || 'conversation',
      webSearch: !!record.webSearch,
      system: playbook.system,
      messages,
      searches: record.searches || [],
      resumes: record.resumes || 0,
      usage: record.usage || null,
      cost: record.cost ?? null,
      // Characters, so the UI can show where the input tokens went.
      promptChars,
      searchChars,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
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
    // 'gaps' picks the same rows as 'unanswered' but runs only their missing
    // steps; the client can also send explicit ids with onlyMissing.
    if (body.scope === 'unanswered' || body.scope === 'gaps') {
      const answers = read(listFile(list.id, 'answers'), {});
      const playbook = playbookOf(list.id);
      const enabled = automaticSteps(playbook);
      ids = investors.rows
        .filter((r) => enabled.some((s) => !answers[r.__id]?.steps?.[s.id]?.text))
        .map((r) => r.__id);
    }

    res.json(
      startRun({
        listId: list.id,
        listName: list.name,
        investorIds: ids,
        stepIds: body.stepIds,
        onlyMissing: body.scope === 'gaps' || !!body.onlyMissing,
        scopeLabel: body.scopeLabel,
        // Per-run overrides; the saved settings are left alone.
        concurrency: body.concurrency,
        effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort) ? body.effort : undefined,
      })
    );
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// What has been spent so far, overall and per list.
app.get('/api/cost', (_req, res) => {
  const byList = getLists().map((l) => {
    const { cost, costUnknown, calls } = listStats(l.id);
    return { id: l.id, name: l.name, cost, costUnknown, calls };
  });
  res.json({
    total: byList.reduce((n, l) => n + l.cost, 0),
    calls: byList.reduce((n, l) => n + l.calls, 0),
    unknown: byList.some((l) => l.costUnknown),
    byList,
    model: { ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) }.model,
    modelPriced: knownModel({ ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) }.model),
  });
});

app.get('/api/run/status', (_req, res) => res.json(jobStatus()));
app.post('/api/run/cancel', (_req, res) => res.json({ cancelled: cancelJob() }));

// ------------------------------------------------------------------- export

app.get('/api/lists/:listId/export.csv', (req, res) => {
  try {
    const list = findList(req.params.listId);
    const investors = readRowsMerged(list.id);
    const answers = read(listFile(list.id, 'answers'), {});
    const playbook = playbookOf(list.id);
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
  if (!exists('playbooks')) write('playbooks', []);

  // Migrate the pre-multi-list layout (data/{investors,playbook,answers}.json).
  if (exists('investors') && !getLists().length) {
    const old = read('investors', { columns: [], rows: [] });
    if (old.rows.length) {
      const entry = createList({
        name: old.source || 'Imported list',
        source: old.source,
        csv: toCsv(old.columns, old.rows),
      });
      if (exists('playbook')) {
        const lists = getLists();
        const row = lists.find((l) => l.id === entry.id);
        row.playbookId = savePlaybook(crypto.randomUUID().slice(0, 8), {
          ...read('playbook', DEFAULT_PLAYBOOK),
          name: `${entry.name} playbook`,
        }).id;
        write('lists', lists);
      }
      if (exists('answers')) write(listFile(entry.id, 'answers'), read('answers', {}));
      console.log(`Migrated existing data into list "${entry.name}".`);
    }
    for (const f of ['investors', 'playbook', 'answers']) {
      const p = path.join(ROOT, 'data', f + '.json');
      if (fs.existsSync(p)) fs.renameSync(p, p + '.migrated');
    }
  }

  // Playbooks used to live inside each list; lift them out into saved ones.
  {
    const lists = getLists();
    let changed = false;
    for (const l of lists) {
      if (l.playbookId || !exists(listFile(l.id, 'playbook'))) continue;
      const old = read(listFile(l.id, 'playbook'), DEFAULT_PLAYBOOK);
      l.playbookId = savePlaybook(crypto.randomUUID().slice(0, 8), {
        ...old,
        name: `${l.name} playbook`,
      }).id;
      write(listFile(l.id, 'playbook.migrated'), old);
      removeFile(listFile(l.id, 'playbook'));
      changed = true;
      console.log(`Saved "${l.name}" playbook as a reusable playbook.`);
    }
    if (changed) write('lists', lists);
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
        playbookName: 'Investor research',
      });
      console.log(`Seeded list "${entry.name}" from funding-round-investors.csv`);
    }
  }
}

bootstrap();

// A stray rejection anywhere should not take the server down mid-run.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.stack || err);
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`Investor playbook running at http://localhost:${port}`));
