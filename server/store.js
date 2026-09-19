// Tiny JSON-file store. Everything lives under ./data (gitignored).
//
// Layout:
//   data/settings.json            global (API key, model, …)
//   data/lists.json               the index of lists
//   data/lists/<id>/investors.json
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

// Per-list file names, e.g. listFile('abc', 'answers') -> 'lists/abc/answers'.
export function listFile(id, kind) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid list id');
  return path.posix.join('lists', id, kind);
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
