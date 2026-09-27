// "Ask for Intro": who could introduce me to the people worth meeting.
//
// Two halves. First you name people you know — each is matched to a first-degree
// connection, from the network you already saved where possible, otherwise by
// searching LinkedIn. Then you give a search term, and for every introducer the
// agent asks LinkedIn for second-degree people matching that term *via them*,
// reads each of those profiles (About, and every position with its dates — the
// board and observer seats are the point), and puts the profile to the model
// with your prompt. One row per (introducer, person) pair.
import crypto from 'node:crypto';
import { read, write, DEFAULT_SETTINGS, DEFAULT_SYSTEM } from '../store.js';
import * as agent from './agent.js';
import * as network from './network.js';
import { makeClient, askLLM } from '../llm.js';
import { costOf } from '../pricing.js';
import { nameScore } from './match.js';

const KEY = 'linkedin-intro';

export const DEFAULT_PROMPT =
  'Here is a LinkedIn profile of someone a contact of mine can introduce me to. ' +
  'In one short line, say whether they are worth an introduction for a seed-stage ' +
  'cybersecurity startup raising now, and why. Start the line with Yes, No or Maybe.';

const blank = () => ({ introducers: [], searches: [], rows: [], prompt: DEFAULT_PROMPT });

const load = () => ({ ...blank(), ...read(KEY, blank()) });
const save = (state) => write(KEY, state);

const id = () => crypto.randomUUID().slice(0, 8);
const settings = () => ({ ...DEFAULT_SETTINGS, ...read('settings', DEFAULT_SETTINGS) });

// ------------------------------------------------------------------- progress

let queue = [];
let running = false;
let current = null;
let log = [];

const note = (msg) => {
  log.push({ t: new Date().toISOString(), msg });
  if (log.length > 300) log.splice(0, log.length - 300);
};

export const status = () => ({
  running,
  current,
  pending: queue.length,
  log: log.slice(-120),
});

export function state() {
  const s = load();
  return { ...s, ...status() };
}

// ---------------------------------------------------------------- introducers

const shortUrl = (u) => String(u || '').replace(/\/$/, '');

/**
 * Someone you know. Matched against the saved network first — that costs no
 * LinkedIn traffic at all — and only searched for when nothing there fits.
 */
export function addIntroducer(query) {
  const name = String(query || '').trim();
  if (!name) throw new Error('Name the person you know.');
  const s = load();

  if (s.introducers.some((i) => i.query.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} is already on the list.`);
  }

  const entry = { id: id(), query: name, name, url: '', headline: '', degree: null, status: 'queued', addedAt: new Date().toISOString() };

  // A name already in your network is a first-degree connection by definition.
  const best = bestInNetwork(name);
  if (best) {
    Object.assign(entry, {
      name: best.person.name,
      url: shortUrl(best.person.url),
      headline: best.person.headline || '',
      degree: '1st',
      confidence: best.score,
      source: 'network',
      status: 'ok',
    });
  }

  s.introducers.push(entry);
  save(s);
  if (entry.status === 'ok') {
    note(`${entry.name} is in your saved network — added without asking LinkedIn.`);
  } else {
    enqueue({ kind: 'introducer', introducerId: entry.id, label: name });
  }
  return entry;
}

function bestInNetwork(name) {
  let best = null;
  for (const person of network.all()) {
    const score = nameScore(name, person.name);
    if (score >= 0.9 && (!best || score > best.score)) best = { person, score };
  }
  return best;
}

export function removeIntroducer(introducerId) {
  const s = load();
  s.introducers = s.introducers.filter((i) => i.id !== introducerId);
  // Their rows go too: a row's whole point is who could make the introduction.
  s.rows = s.rows.filter((r) => r.introducerId !== introducerId);
  save(s);
  queue = queue.filter((j) => j.introducerId !== introducerId);
  return state();
}

// -------------------------------------------------------------------- searches

/** A term to look for among the second-degree connections of your introducers. */
export function addSearch({ term, prompt }) {
  const text = String(term || '').trim();
  if (!text) throw new Error('Give a search term.');
  const s = load();
  const ready = s.introducers.filter((i) => i.url);
  if (!ready.length) throw new Error('Add someone you know first — a search runs through their connections.');

  // The same term again is a re-run, not a second search: its rows are keyed
  // on (search, introducer, profile), so they refresh in place.
  let entry = s.searches.find((x) => x.term.toLowerCase() === text.toLowerCase());
  const again = !!entry;
  if (entry) {
    Object.assign(entry, {
      prompt: String(prompt || entry.prompt || DEFAULT_PROMPT).trim(),
      status: 'queued',
      introducers: ready.length,
      error: null,
    });
  } else {
    entry = {
      id: id(),
      term: text,
      prompt: String(prompt || s.prompt || DEFAULT_PROMPT).trim(),
      createdAt: new Date().toISOString(),
      status: 'queued',
      introducers: ready.length,
    };
    s.searches.push(entry);
  }
  s.prompt = entry.prompt; // remembered for the next search
  save(s);
  if (again) note(`Running "${text}" again — existing rows are refreshed, not duplicated.`);

  for (const i of ready) {
    enqueue({ kind: 'search', searchId: entry.id, introducerId: i.id, label: `${text} via ${i.name}` });
  }
  return entry;
}

export function removeSearch(searchId) {
  const s = load();
  s.searches = s.searches.filter((x) => x.id !== searchId);
  s.rows = s.rows.filter((r) => r.searchId !== searchId);
  save(s);
  queue = queue.filter((j) => j.searchId !== searchId);
  return state();
}

export function clearQueue() {
  const dropped = queue.length;
  queue = [];
  const s = load();
  for (const x of s.searches) if (x.status === 'queued') x.status = 'stopped';
  for (const i of s.introducers) if (i.status === 'queued') i.status = 'stopped';
  save(s);
  if (dropped) note(`Dropped ${dropped} queued job${dropped === 1 ? '' : 's'}.`);
  return state();
}

/** Ask the model again about one row — after changing the prompt, usually. */
export async function reask(rowId, prompt) {
  const s = load();
  const row = s.rows.find((r) => r.id === rowId);
  if (!row) throw new Error('No such row.');
  const text = String(prompt || s.prompt || DEFAULT_PROMPT).trim();
  const answer = await ask(row, text);
  const fresh = load();
  const target = fresh.rows.find((r) => r.id === rowId);
  if (target) Object.assign(target, answer, { prompt: text });
  fresh.prompt = text;
  save(fresh);
  return target;
}

// ----------------------------------------------------------------------- queue
// One job at a time. Every LinkedIn page load is paced by the agent itself;
// running two of these at once would just get the account throttled.

function enqueue(job) {
  queue.push(job);
  drain().catch((err) => note(`Stopped: ${err.message}`));
}

async function ensureSession() {
  let s = await agent.status();
  if (!s.open) {
    note('Opening the LinkedIn agent window…');
    s = await agent.openSession();
  }
  if (!s.open) return false;
  if (!s.loggedIn) {
    note('Waiting for you to sign in to LinkedIn in the agent window…');
    s = await agent.waitForLogin();
    if (s.loggedIn) note('Signed in — carrying on.');
  }
  return !!s.loggedIn;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      if (!(await ensureSession())) {
        note(`Paused — no signed-in LinkedIn session. ${queue.length} job${queue.length === 1 ? '' : 's'} waiting.`);
        break;
      }
      const job = queue.shift();
      if (!job) break;
      current = job.label;
      try {
        if (job.kind === 'introducer') await runIntroducer(job);
        else await runSearch(job);
      } catch (err) {
        note(`${job.label}: ${err.message}`);
        markFailed(job, err.message);
      }
      current = null;
    }
  } finally {
    running = false;
    current = null;
  }
}

function markFailed(job, message) {
  const s = load();
  if (job.kind === 'introducer') {
    const i = s.introducers.find((x) => x.id === job.introducerId);
    if (i) Object.assign(i, { status: 'error', error: message });
  } else {
    const x = s.searches.find((y) => y.id === job.searchId);
    if (x && x.status !== 'done') Object.assign(x, { status: 'error', error: message });
  }
  save(s);
}

/** Find the person you named among your first-degree connections. */
async function runIntroducer(job) {
  const s0 = load();
  const entry = s0.introducers.find((i) => i.id === job.introducerId);
  if (!entry) return;

  note(`Looking for ${entry.query} among your connections…`);
  const { candidates, best } = await agent.searchByName(entry.query);
  const first = candidates.filter((c) => c.degree === '1st');
  const pick = first[0] || null;

  const s = load();
  const row = s.introducers.find((i) => i.id === job.introducerId);
  if (!row) return;

  if (!pick) {
    Object.assign(row, {
      status: best ? 'unsure' : 'error',
      error: best
        ? `Closest match was ${best.name}${best.degree ? ` (${best.degree})` : ''}, not a first-degree connection.`
        : 'Nobody came back for that name.',
      candidates: candidates.slice(0, 3).map(brief),
    });
    note(`${entry.query}: ${row.error}`);
  } else {
    Object.assign(row, {
      name: pick.name,
      url: shortUrl(pick.url),
      headline: pick.headline || '',
      degree: '1st',
      confidence: pick.confidence,
      source: 'search',
      status: 'ok',
      error: null,
      candidates: candidates.slice(0, 3).map(brief),
    });
    note(`${entry.query} → ${pick.name} (1st degree).`);
  }
  save(s);
}

const brief = (c) => ({
  name: c.name,
  headline: c.headline || '',
  degree: c.degree || null,
  url: shortUrl(c.url),
  confidence: c.confidence,
});

/** Second-degree people matching the term, through one introducer. */
async function runSearch(job) {
  const s0 = load();
  const search = s0.searches.find((x) => x.id === job.searchId);
  const introducer = s0.introducers.find((i) => i.id === job.introducerId);
  if (!search || !introducer?.url) return;

  note(`Searching "${search.term}" among ${introducer.name}'s connections…`);
  const { people, constrained, reason, picked, searchUrl } = await agent.searchConnectionsOf({
    term: search.term,
    introducerName: introducer.name,
  });

  // Without the "Connections of" filter this page is every match on LinkedIn,
  // not the ones this person can reach. Those are not rows, and pretending
  // otherwise is the whole failure mode worth guarding against.
  if (!constrained) {
    note(`Skipped ${introducer.name}: ${reason}`);
    const s = load();
    const x = s.searches.find((y) => y.id === job.searchId);
    if (x) {
      x.skipped = [...(x.skipped || []).filter((k) => k.introducerId !== introducer.id), { introducerId: introducer.id, name: introducer.name, reason }];
      x.status = queue.some((j) => j.searchId === job.searchId) ? 'running' : 'done';
    }
    save(s);
    return;
  }
  if (picked) note(`Filtered to ${introducer.name}'s connections (matched "${picked}").`);

  // LinkedIn's facet is a request, not a promise: keep only what came back as
  // second-degree, so a stray first- or third-degree hit does not become a row.
  const targets = people.filter((p) => p.url && (p.degree === '2nd' || p.degree === null));
  note(`${targets.length} second-degree match${targets.length === 1 ? '' : 'es'} via ${introducer.name}.`);

  {
    const s = load();
    const x = s.searches.find((y) => y.id === job.searchId);
    if (x) Object.assign(x, { status: 'running', searchUrl });
    save(s);
  }

  for (const target of targets) {
    // The same person can come up through two introducers; that is two rows,
    // because the introduction is what differs. Through the same one it is the
    // same row, re-read and re-asked.
    const existing = load().rows.find(
      (r) => r.searchId === search.id && r.introducerId === introducer.id && r.url === shortUrl(target.url)
    );
    const rowId = existing?.id || id();
    let row = {
      id: rowId,
      searchId: search.id,
      term: search.term,
      introducerId: introducer.id,
      introducerName: introducer.name,
      introducerUrl: introducer.url,
      name: target.name,
      url: shortUrl(target.url),
      headline: target.headline || '',
      degree: '2nd',
      status: 'reading',
      at: new Date().toISOString(),
    };
    upsertRow(row);

    let profile;
    try {
      profile = await agent.readProfileDetail(target.url);
    } catch (err) {
      upsertRow({ ...row, status: 'error', error: `Could not read the profile: ${err.message}` });
      continue;
    }

    row = {
      ...row,
      name: profile.name || row.name,
      headline: profile.headline || row.headline,
      company: profile.company || '',
      summary: profile.summary || '',
      positions: profile.positions || [],
      experienceText: profile.experienceText || '',
      status: 'asking',
    };
    upsertRow(row);

    const answered = await ask(row, search.prompt);
    upsertRow({ ...row, ...answered, prompt: search.prompt, status: answered.error ? 'error' : 'done' });
    note(`${row.name}: ${answered.error ? answered.error : firstLine(answered.answer)}`);
  }

  const s = load();
  const x = s.searches.find((y) => y.id === job.searchId);
  const done = !queue.some((j) => j.searchId === job.searchId);
  if (x) Object.assign(x, { status: done ? 'done' : 'running', finishedAt: done ? new Date().toISOString() : null });
  save(s);
}

const firstLine = (t) => String(t || '').split('\n')[0].slice(0, 120);

function upsertRow(row) {
  const s = load();
  const at = s.rows.findIndex((r) => r.id === row.id);
  if (at >= 0) s.rows[at] = { ...s.rows[at], ...row };
  else s.rows.push(row);
  save(s);
}

// ------------------------------------------------------------------- the model

/** The profile as text, for a prompt. Positions carry their dates. */
export function profileBlock(row) {
  const lines = [`Name: ${row.name}`];
  if (row.headline) lines.push(`Headline: ${row.headline}`);
  if (row.company) lines.push(`Company: ${row.company}`);
  if (row.summary) lines.push(`About: ${row.summary}`);
  if (row.positions?.length) {
    lines.push('Positions:');
    for (const p of row.positions) {
      const bits = [p.title, p.company].filter(Boolean).join(' — ');
      lines.push(`- ${bits}${p.dates ? ` (${p.dates})` : ''}${p.description ? `: ${p.description}` : ''}`);
    }
  } else if (row.experienceText) {
    lines.push(`Experience (unparsed):\n${row.experienceText}`);
  }
  return lines.join('\n');
}

const TOKENS = /\{\{\s*(name|headline|company|summary|positions|profile|introducer)\s*\}\}/g;

/** The prompt with its tokens filled in, or the prompt then the profile. */
export function renderPrompt(prompt, row) {
  const values = {
    name: row.name || '',
    headline: row.headline || '',
    company: row.company || '',
    summary: row.summary || '',
    positions: (row.positions || [])
      .map((p) => `${[p.title, p.company].filter(Boolean).join(' — ')}${p.dates ? ` (${p.dates})` : ''}`)
      .join('; '),
    profile: profileBlock(row),
    introducer: row.introducerName || '',
  };
  if (TOKENS.test(prompt)) return prompt.replace(TOKENS, (_, k) => values[k] ?? '');
  return `${prompt}\n\n${profileBlock(row)}`;
}

async function ask(row, prompt) {
  const s = settings();
  if (!s.apiKey) return { answer: '', error: 'No Anthropic API key. Add one on the Settings tab.' };
  try {
    const client = makeClient(s.apiKey);
    const result = await askLLM(client, {
      system: DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: renderPrompt(prompt, row) }],
      settings: s,
    });
    const cost = costOf(s.model, result.usage);
    return {
      answer: (result.text || '').trim(),
      cost: cost || 0,
      costUnknown: cost === null,
      usage: result.usage || null,
      model: s.model,
      error: null,
      answeredAt: new Date().toISOString(),
    };
  } catch (err) {
    return { answer: '', error: err.message };
  }
}

/** What the rows cost to answer, all together. */
export const totalCost = () => load().rows.reduce((sum, r) => sum + (r.cost || 0), 0);
