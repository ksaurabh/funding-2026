// Tiny JSON-file store. Everything lives under ./data (gitignored).
//
// Layout:
//   data/settings.json            global (API key, model, …)
//   data/lists.json               the index of lists
//   data/playbooks.json           the index of saved playbooks
//   data/playbooks/<id>.json      one playbook, usable by any number of lists
//   data/lists/<id>/investors.json   pristine rows as imported
//   data/lists/<id>/edits.json       cell values you (or a step) have written
//   data/lists/<id>/schema.json      editable columns: CSV ones plus added ones
//   data/lists/<id>/playbook.json
//   data/lists/<id>/answers.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
const LISTS_DIR = path.join(DATA_DIR, 'lists');

fs.mkdirSync(LISTS_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'playbooks'), { recursive: true });

function resolveFile(name) {
  // `name` is either "settings" or "<listId>/answers".
  const p = path.join(DATA_DIR, name + '.json');
  if (!p.startsWith(DATA_DIR + path.sep)) throw new Error('Invalid store path');
  return p;
}

export function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(resolveFile(name), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

// Write atomically so a crash mid-run can't truncate answers.json.
export function write(name, value) {
  const target = resolveFile(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
  return value;
}

export function exists(name) {
  return fs.existsSync(resolveFile(name));
}

export function removeList(id) {
  fs.rmSync(path.join(LISTS_DIR, id), { recursive: true, force: true });
}

export function removeFile(name) {
  fs.rmSync(path.join(DATA_DIR, name + '.json'), { force: true });
}

const safeId = (id) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('Invalid id');
  return id;
};

// Per-list file names, e.g. listFile('abc', 'answers') -> 'lists/abc/answers'.
export function listFile(id, kind) {
  return path.posix.join('lists', safeId(id), kind);
}

export const playbookFile = (id) => path.posix.join('playbooks', safeId(id));

// A list's column settings, keyed by column name:
//   { editable, type: 'text' | 'enum', values: string[], custom, show }
//
// Imported columns are shown but read-only until you say otherwise; a column
// added here is editable from the start, since it would be useless read-only.
// `type` only matters once a column is editable, and defaults to free text.
export const DEFAULT_SCHEMA = { fields: {} };

const DEFAULT_SHOWN = 4;

export function defaultField(custom = false, show = true) {
  return { editable: custom, type: 'text', values: [], custom, show, filter: false };
}

/**
 * Column settings for a list, with defaults filled in for every imported
 * column. Reading never writes, so untouched lists keep an empty schema file.
 */
export function readSchema(listId, columns) {
  const raw = read(listFile(listId, 'schema'), DEFAULT_SCHEMA);
  const cols = columns || read(listFile(listId, 'investors'), { columns: [] }).columns;

  let saved = raw.fields || {};
  // Migrate the two earlier shapes: { enums: {col: values} } and a fields array.
  // Anything configured back then was deliberately made editable.
  if (Array.isArray(saved)) {
    saved = Object.fromEntries(
      saved.map((f) => [
        f.name,
        { editable: true, type: f.type || 'enum', values: f.values || [], custom: !!f.custom, show: true },
      ])
    );
  } else if (!raw.fields && raw.enums) {
    saved = Object.fromEntries(
      Object.entries(raw.enums).map(([name, values]) => [
        name,
        { editable: true, type: 'enum', values, custom: false, show: true },
      ])
    );
  }

  const fields = {};
  cols.forEach((name, i) => {
    const f = saved[name] || {};
    fields[name] = {
      // Imported data is reference material until you opt it in.
      editable: !!f.editable,
      type: f.type === 'enum' ? 'enum' : 'text',
      values: f.values || [],
      // Any column can be filtered on; dropdowns are on the bar by default
      // because a fixed set of values is what you usually want to slice by.
      filter: f.filter === undefined ? f.type === 'enum' : !!f.filter,
      custom: false,
      // Imported columns past the first few stay out of the table until asked for.
      show: f.show === undefined ? i < DEFAULT_SHOWN : !!f.show,
    };
  });
  // Columns added here, in the order they were added.
  for (const [name, f] of Object.entries(saved)) {
    if (fields[name] || !f.custom) continue;
    fields[name] = {
      editable: f.editable !== false,
      type: f.type === 'enum' ? 'enum' : 'text',
      values: f.values || [],
      filter: f.filter === undefined ? f.type === 'enum' : !!f.filter,
      custom: true,
      show: f.show !== false,
    };
  }
  return { fields };
}

export const findField = (schema, name) => schema.fields[name];

/**
 * Rows as imported, with cell values layered on top. investors.json stays
 * pristine so a re-import keeps edits for any row id that survives, and added
 * columns live only in edits.json.
 */
export function readRowsMerged(listId) {
  const investors = read(listFile(listId, 'investors'), { columns: [], rows: [] });
  const schema = readSchema(listId, investors.columns);
  const edits = read(listFile(listId, 'edits'), {});

  const addedNames = Object.entries(schema.fields)
    .filter(([name, f]) => f.custom && !investors.columns.includes(name))
    .map(([name]) => name);
  const allColumns = [...investors.columns, ...addedNames];
  const allowed = new Set(allColumns);

  const rows = investors.rows.map((r) => {
    const base = addedNames.length ? { ...r, ...Object.fromEntries(addedNames.map((n) => [n, ''])) } : r;
    const patch = edits[r.__id];
    if (!patch) return base;
    const clean = {};
    for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) clean[k] = v;
    return { ...base, ...clean };
  });

  return { columns: investors.columns, addedColumns: addedNames, allColumns, rows, schema };
}

/** Write one cell into edits.json. */
export function writeCell(listId, rowId, column, value) {
  const key = listFile(listId, 'edits');
  const edits = read(key, {});
  edits[rowId] = { ...edits[rowId], [column]: value };
  write(key, edits);
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  maxTokens: 8000,
  concurrency: 1,
};

export const DEFAULT_SYSTEM =
  'You are a research analyst helping a cybersecurity startup evaluate venture investors. ' +
  'Be concise, concrete and honest. If you are not confident about a fact, say so explicitly ' +
  'rather than inventing details.';

export const DEFAULT_PLAYBOOK = {
  name: 'Untitled playbook',
  system: DEFAULT_SYSTEM,
  mode: 'conversation', // 'conversation' = steps share one thread | 'independent' = each step is its own call
  steps: [],
};

// Seeded only into the list created from the bundled investor CSV.
export const SAMPLE_STEPS = [
  {
    id: 'seed-thesis',
    name: 'Investment thesis',
    key: 'thesis',
    webSearch: true,
    enabled: true,
    prompt:
      'Research the venture firm "{{Lead Investor}}".\n\n' +
      'They have led {{Deals}} cybersecurity rounds with an average size of ${{Avg Round Size (USD)}}, ' +
      'between {{Min Announced Date}} and {{Max Announced Date}}. Portfolio companies in this dataset:\n' +
      '{{Companies}}\n\n' +
      'Summarise in under 200 words: their stated investment thesis, the stages and cheque sizes they lead, ' +
      'and how central cybersecurity is to the firm.',
  },
  {
    id: 'seed-partners',
    name: 'Who to contact',
    key: 'partners',
    webSearch: true,
    enabled: true,
    prompt:
      'Which partners at {{Lead Investor}} lead cybersecurity investments? For each, give their name, title, ' +
      'a notable security deal they led, and where they are based. If you cannot verify a name, say so ' +
      'instead of guessing.',
  },
  {
    id: 'seed-fit',
    name: 'Fit and conflicts',
    key: 'fit',
    webSearch: false,
    enabled: true,
    prompt:
      'Based on what you found above, rate 1-5 how good a fit {{Lead Investor}} is for an AI-native security ' +
      'operations (SOC automation) startup raising a Series A, and explain the rating in two sentences. ' +
      'Then list any portfolio companies from {{Companies}} that would be a direct conflict.',
  },
];
