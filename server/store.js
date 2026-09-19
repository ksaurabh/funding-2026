// Tiny JSON-file store. Everything lives under ./data (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) {
  return path.join(DATA_DIR, name + '.json');
}

export function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

// Write atomically so a crash mid-run can't truncate answers.json.
export function write(name, value) {
  const target = file(name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
  return value;
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  maxTokens: 8000,
  concurrency: 1,
};

export const DEFAULT_PLAYBOOK = {
  system:
    'You are a research analyst helping a cybersecurity startup evaluate venture investors. ' +
    'Be concise, concrete and honest. If you are not confident about a fact, say so explicitly ' +
    'rather than inventing details.',
  mode: 'conversation', // 'conversation' = steps share one thread | 'independent' = each step is its own call
  steps: [
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
  ],
};
