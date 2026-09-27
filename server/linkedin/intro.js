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
  'Here is the LinkedIn profile of someone a contact of mine could introduce me to. ' +
  'I am raising a seed round for a cybersecurity startup.\n\n' +
  'Answer with one category from: Investor, Angel, Operator, Advisor, Recruiter, Other — ' +
  'then a dash and at most twelve words saying why. For example: ' +
  '"Investor — leads seed security rounds, board observer at two.".\n\n' +
  '{{profile}}';

const blank = () => ({ introducers: [], jobs: [], rows: [], prompt: DEFAULT_PROMPT });

function load() {
  const raw = { ...blank(), ...read(KEY, blank()) };
  // Earlier shape: a "search" was a term run across every connection at once.
  // A job is that same work, named for the pair it actually is.
  if (raw.searches?.length && !raw.jobs.length) {
    raw.jobs = raw.searches.flatMap((x) =>
      raw.introducers
        .filter((i) => raw.rows.some((r) => r.searchId === x.id && r.introducerId === i.id))
        .map((i) => ({
          id: `${x.id}-${i.id}`.slice(0, 16),
          introducerId: i.id,
          introducerName: i.name,
          term: x.term,
          prompt: x.prompt || raw.prompt,
          status: x.status === 'done' ? 'done' : 'stopped',
          lastRunAt: x.finishedAt || x.createdAt || null,
          found: raw.rows.filter((r) => r.searchId === x.id && r.introducerId === i.id).length,
        }))
    );
    for (const r of raw.rows) {
      const job = raw.jobs.find((j) => r.searchId?.startsWith(j.id.split('-')[0]) && j.introducerId === r.introducerId);
      if (job) r.jobId = job.id;
    }
    delete raw.searches;
  }
  return raw;
}
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
  // Their jobs and rows go too: a row's whole point is who could introduce you.
  s.jobs = s.jobs.filter((j) => j.introducerId !== introducerId);
  s.rows = s.rows.filter((r) => r.introducerId !== introducerId);
  save(s);
  queue = queue.filter((j) => j.introducerId !== introducerId);
  return state();
}

// ------------------------------------------------------------------------ jobs
// A job is one connection × one term × one prompt: "find me the people matching
// this among Dana's connections, and ask Jev this about each of them".

const jobLabel = (job) => `${job.term} via ${job.introducerName}`;

/** Every term used so far, for picking instead of retyping. */
export const terms = () => [...new Set(load().jobs.map((j) => j.term))].sort();

/**
 * A job names the person it goes through, rather than pointing at one picked
 * from a list: that person is looked up if they are new, and the job waits its
 * turn behind that lookup — the queue is FIFO, so by the time the job runs the
 * connection has been matched or has failed to be.
 */
export function addJob({ connectionName, introducerId, term, prompt }) {
  const text = String(term || '').trim();
  if (!text) throw new Error('Give a search term.');
  const who = String(connectionName || '').trim();
  if (!who && !introducerId) throw new Error('Name the 1st degree connection to go through.');

  let s = load();
  let introducer = introducerId
    ? s.introducers.find((i) => i.id === introducerId)
    : s.introducers.find((i) => i.query.toLowerCase() === who.toLowerCase() || i.name.toLowerCase() === who.toLowerCase());

  // A name not seen before is added here, which queues its lookup.
  if (!introducer) {
    introducer = addIntroducer(who);
    s = load();
  }
  if (!introducer) throw new Error('Could not add that connection.');

  const ask = String(prompt || s.prompt || DEFAULT_PROMPT).trim();
  if (!ask) throw new Error('Give Jev a prompt.');

  // The same pair again is a re-run, not a second job.
  let job = s.jobs.find((j) => j.introducerId === introducer.id && j.term.toLowerCase() === text.toLowerCase());
  if (job) {
    Object.assign(job, { prompt: ask, status: 'queued', error: null, skipped: null });
  } else {
    job = {
      id: id(),
      introducerId: introducer.id,
      introducerName: introducer.name,
      connectionQuery: introducer.query,
      term: text,
      prompt: ask,
      status: 'queued',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      found: 0,
    };
    s.jobs.push(job);
  }
  s.prompt = ask; // the next job starts from the last prompt you used
  save(s);
  enqueue({ kind: 'job', jobId: job.id, introducerId: introducer.id, label: jobLabel(job) });
  return job;
}

/** Run an existing job again, with its own prompt or a new one. */
export function runJobAgain(jobId, prompt) {
  const s = load();
  const job = s.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error('No such job.');
  if (prompt) job.prompt = String(prompt).trim();
  Object.assign(job, { status: 'queued', error: null, skipped: null });
  save(s);
  enqueue({ kind: 'job', jobId: job.id, introducerId: job.introducerId, label: jobLabel(job) });
  return job;
}

export function removeJob(jobId) {
  const s = load();
  s.jobs = s.jobs.filter((j) => j.id !== jobId);
  s.rows = s.rows.filter((r) => r.jobId !== jobId);
  save(s);
  queue = queue.filter((j) => j.jobId !== jobId);
  return state();
}

export function clearQueue() {
  const dropped = queue.length;
  queue = [];
  const s = load();
  for (const x of s.jobs) if (x.status === 'queued') x.status = 'stopped';
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
        else await runJob(job);
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
    const x = s.jobs.find((y) => y.id === job.jobId);
    if (x) Object.assign(x, { status: 'error', error: message, lastRunAt: new Date().toISOString() });
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
async function runJob(job) {
  const s0 = load();
  const entry = s0.jobs.find((x) => x.id === job.jobId);
  const introducer = s0.introducers.find((i) => i.id === job.introducerId);
  if (!entry) return;

  // The connection is looked up ahead of this job in the same queue, so by now
  // it has either been matched or has a reason it was not.
  if (!introducer?.url) {
    const why =
      introducer?.error ||
      (introducer ? `${introducer.name} was not matched to a first-degree connection.` : 'That connection is gone.');
    note(`Stopped ${jobLabel(entry)}: ${why}`);
    const s = load();
    const x = s.jobs.find((y) => y.id === job.jobId);
    if (x) Object.assign(x, { status: 'error', error: why, lastRunAt: new Date().toISOString() });
    save(s);
    return;
  }
  // The name may have been resolved since the job was made.
  if (entry.introducerName !== introducer.name) {
    const s = load();
    const x = s.jobs.find((y) => y.id === job.jobId);
    if (x) x.introducerName = introducer.name;
    save(s);
    entry.introducerName = introducer.name;
  }

  const patchJob = (fields) => {
    const s = load();
    const x = s.jobs.find((y) => y.id === job.jobId);
    if (x) Object.assign(x, fields);
    save(s);
  };

  patchJob({ status: 'running', startedAt: new Date().toISOString() });
  note(`Searching "${entry.term}" among ${introducer.name}'s connections…`);
  const {
    people,
    constrained,
    reason,
    detail,
    shot,
    html,
    shotPath,
    htmlPath,
    picked,
    pickedText,
    pickedAssumed,
    searchUrl,
    pages,
  } = await agent.searchConnectionsOf({
    term: entry.term,
    introducerName: introducer.name,
    // Say how it is going: ten pages is a few minutes of paced loading.
    onPage: ({ page, added, total }) =>
      note(`Page ${page} via ${introducer.name}: ${added} new, ${total} so far.`),
  });

  // Without the "Connections of" filter this page is every match on LinkedIn,
  // not the ones this person can reach. Those are not rows, and pretending
  // otherwise is the whole failure mode worth guarding against.
  if (!constrained) {
    note(`Stopped ${jobLabel(entry)}: ${reason}`);
    // The picture and the markup go with the reason: a filter panel that has
    // moved is only fixable against what it actually looked like.
    patchJob({
      status: 'error',
      error: reason,
      skipped: {
        reason,
        detail: detail || null,
        shot: shot?.file || null,
        html: html || shot?.html || null,
        // Absolute paths, so the files can be opened from anywhere.
        shotPath: shotPath || null,
        htmlPath: htmlPath || null,
        at: new Date().toISOString(),
      },
      lastRunAt: new Date().toISOString(),
    });
    return;
  }
  if (picked) {
    note(
      pickedAssumed
        ? `Filtered to "${picked}" — LinkedIn's first suggestion, which did not clearly match ${introducer.name}.`
        : `Filtered to ${introducer.name}'s connections (matched "${picked}").`
    );
  }
  // Which row of the dropdown the results actually came from, so a wrong pick
  // is visible on the card instead of quietly shaping everything below it.
  patchJob({ picked: picked || null, pickedText: pickedText || null, pickedAssumed: !!pickedAssumed });

  // Everyone on this page, whatever degree they read as. The page is already
  // proven to be this connection's own connections — that is what the facet
  // check bought — and they are all people this connection could introduce.
  // Some come back marked 1st: you know them directly too, which is worth
  // knowing rather than a reason to drop them.
  const targets = people.filter((p) => p.url);
  const firsts = targets.filter((p) => p.degree === '1st').length;
  note(
    `${targets.length} match${targets.length === 1 ? '' : 'es'} via ${introducer.name}` +
      ` across ${pages || 1} page${pages === 1 ? '' : 's'}` +
      (firsts ? ` — ${firsts} you already know directly.` : '.')
  );
  patchJob({ pages: pages || 1 });
  patchJob({ searchUrl, found: targets.length });

  for (const target of targets) {
    // The same person through the same connection is the same row, re-read and
    // re-asked; through a different connection it is a different introduction.
    const existing = load().rows.find((r) => r.jobId === entry.id && r.url === shortUrl(target.url));
    const rowId = existing?.id || id();
    let row = {
      id: rowId,
      jobId: entry.id,
      term: entry.term,
      introducerId: introducer.id,
      introducerName: introducer.name,
      introducerUrl: introducer.url,
      name: target.name,
      url: shortUrl(target.url),
      // The card's second line: what LinkedIn shows under the name on the
      // results page. Kept as the person's title, whatever the profile says.
      title: target.headline || '',
      headline: target.headline || '',
      degree: target.degree || null,
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
      // title stays as the search card had it; the profile headline is its own.
      headline: profile.headline || row.headline,
      company: profile.company || companyFrom(profile.headline) || '',
      summary: profile.summary || '',
      positions: profile.positions || [],
      experienceText: profile.experienceText || '',
      status: 'asking',
    };
    upsertRow(row);

    const answered = await ask(row, entry.prompt);
    upsertRow({ ...row, ...answered, prompt: entry.prompt, status: answered.error ? 'error' : 'done' });
    note(`${row.name}: ${answered.error ? answered.error : firstLine(answered.answer)}`);
  }

  patchJob({
    status: 'done',
    error: null,
    skipped: null,
    lastRunAt: new Date().toISOString(),
    found: load().rows.filter((r) => r.jobId === entry.id).length,
  });
}

/** "General Partner at Google Ventures" — the firm is what follows "at". */
const companyFrom = (headline) => String(headline || '').split(/\bat\b/i).slice(1).join(' at ').trim();

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
