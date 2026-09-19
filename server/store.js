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

// A list's editable columns. Each field is either a CSV column made editable
// (custom: false) or a column added here (custom: true, values live in edits).
//   { name, type: 'text' | 'enum', values: string[], custom: boolean }
export const DEFAULT_SCHEMA = { fields: [] };

export function readSchema(listId) {
  const raw = read(listFile(listId, 'schema'), DEFAULT_SCHEMA);
  // Migrate the first shape this feature shipped with: { enums: {col: [...]} }.
  if (!raw.fields && raw.enums) {
    return {
      fields: Object.entries(raw.enums).map(([name, values]) => ({
        name,
        type: 'enum',
        values,
        custom: false,
      })),
    };
  }
  return { fields: raw.fields || [] };
}

export const findField = (schema, name) => schema.fields.find((f) => f.name === name);

/**
 * Rows as imported, with cell values layered on top. investors.json stays
 * pristine so a re-import keeps edits for any row id that survives, and added
 * columns live only in edits.json.
 */
export function readRowsMerged(listId) {
  const investors = read(listFile(listId, 'investors'), { columns: [], rows: [] });
  const schema = readSchema(listId);
  const edits = read(listFile(listId, 'edits'), {});

  const added = schema.fields.filter((f) => f.custom && !investors.columns.includes(f.name));
  const addedNames = added.map((f) => f.name);
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
