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
import { makeClient, askLLM, chooseValue } from '../llm.js';
import { costOf } from '../pricing.js';
import { nameScore, normalise } from './match.js';

const KEY = 'linkedin-intro';

/**
 * How likely it is that someone is an investor, in bands rather than a number:
 * a model asked for "63%" is inventing precision it does not have.
 */
export const ODDS = ['70%+', '50-70%', '30-50%', '10-30%', '<10%'];

/** What a row's relevance can be to start with. The first value is the default. */
export const RELEVANCE = ['Not Set', 'Ignore', 'High'];

const MAX_RELEVANCE = 30;

export const DEFAULT_PROMPT =
  'Here is the LinkedIn profile of someone a contact of mine could introduce me to. ' +
  'I am raising a seed round for a cybersecurity startup.\n\n' +
  'Answer with one category from: Investor, Angel, Operator, Advisor, Recruiter, Other — ' +
  'then a dash and at most twelve words saying why. For example: ' +
  '"Investor — leads seed security rounds, board observer at two.".\n\n' +
  '{{profile}}';

const blank = () => ({ introducers: [], jobs: [], rows: [], prompt: DEFAULT_PROMPT, relevance: [...RELEVANCE] });

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
// Set while a stop has been asked for; the run checks it between steps, and
// the controller cuts short whatever call is in flight.
let stopping = false;
let inFlight = null;
// What the running item is doing, so the view can name what it would stop.
let currentKind = null;

const note = (msg) => {
  log.push({ t: new Date().toISOString(), msg });
  if (log.length > 300) log.splice(0, log.length - 300);
};

export const status = () => ({
  running,
  current,
  currentKind,
  stopping,
  pending: queue.length,
  // What is waiting, by kind, so "stop" can say what it would drop.
  pendingKinds: queue.reduce((acc, q) => ({ ...acc, [q.kind]: (acc[q.kind] || 0) + 1 }), {}),
  log: log.slice(-120),
});

/**
 * Stop the job that is running. It gives up at the next step it reaches —
 * between pages, between people, or in the middle of a model call, which the
 * controller cuts short — and keeps everything it had collected up to there.
 */
export function stopCurrent({ all = false } = {}) {
  // Dropping what is waiting first: a batch of queued work would otherwise
  // carry straight on from where the stopped item left off.
  let dropped = 0;
  if (all && queue.length) {
    dropped = queue.length;
    queue = [];
    const s = load();
    for (const x of s.jobs) if (x.status === 'queued') x.status = 'stopped';
    for (const r of s.rows) if (r.status === 'reading' || r.status === 'asking') r.status = 'done';
    save(s);
    note(`Dropped ${dropped} waiting item${dropped === 1 ? '' : 's'}.`);
  }
  if (!running) return { ...state(), stopped: dropped > 0, dropped };
  stopping = true;
  inFlight?.abort();
  note('Stopping at the next step…');
  return { ...state(), stopped: true, dropped };
}

const stopRequested = () => stopping;

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
export function addJob({ connectionName, introducerId, term, prompt, qualify = true }) {
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

  // Qualifying is optional: without it the job just collects the connections,
  // which costs no profile loads and nothing to the model.
  const wants = qualify !== false;
  const ask = String(prompt || s.prompt || DEFAULT_PROMPT).trim();
  if (wants && !ask) throw new Error('Give Jev a prompt, or turn off qualifying.');

  // The same pair again is a re-run, not a second job.
  let job = s.jobs.find((j) => j.introducerId === introducer.id && j.term.toLowerCase() === text.toLowerCase());
  if (job) {
    Object.assign(job, { prompt: ask, qualify: wants, status: 'queued', error: null, skipped: null });
  } else {
    job = {
      id: id(),
      introducerId: introducer.id,
      introducerName: introducer.name,
      connectionQuery: introducer.query,
      term: text,
      prompt: ask,
      qualify: wants,
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
  if (running && current === jobLabel(job)) throw new Error('That job is running right now.');
  if (prompt) job.prompt = String(prompt).trim();
  Object.assign(job, { status: 'queued', error: null, skipped: null });
  save(s);

  // Asking again for a job already waiting moves it to the front rather than
  // queueing it twice — which is also the way out of a job left saying
  // "queued" after a restart, since this starts the loop either way.
  //
  // Not in front of its own connection's lookup, though: a job that overtakes
  // that runs before there is a profile to search through, and fails saying
  // its connection was never matched.
  queue = queue.filter((q) => q.jobId !== job.id);
  const waitingOn = queue.findLastIndex((q) => q.kind === 'introducer' && q.introducerId === job.introducerId);
  const at = waitingOn + 1;
  queue.splice(at, 0, { kind: 'job', jobId: job.id, introducerId: job.introducerId, label: jobLabel(job) });
  drain().catch((err) => note(`Stopped: ${err.message}`));
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

/**
 * The relevance options. The built-in three always lead, so the default is
 * stable, and anything added on the fly follows in the order it was added.
 */
const relevanceOptions = (s = load()) => [...new Set([...RELEVANCE, ...(s.relevance || [])])];

export const relevance = () => relevanceOptions();

/** A value added from the dropdown, kept for every row from then on. */
export function addRelevance(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('Give the option a name.');
  if (text.length > 40) throw new Error('Keep it under 40 characters.');

  const s = load();
  const existing = relevanceOptions(s).find((v) => v.toLowerCase() === text.toLowerCase());
  // Asking for one that is already there is not an error; it is the same ask.
  if (existing) return { options: relevanceOptions(s), value: existing };
  if (relevanceOptions(s).length >= MAX_RELEVANCE) throw new Error(`That is already ${MAX_RELEVANCE} options.`);

  s.relevance = [...new Set([...RELEVANCE, ...(s.relevance || []), text])];
  save(s);
  return { options: relevanceOptions(s), value: text };
}

/** Your own judgement on a row: how relevant they are, and a note. */
export function markRow(rowId, { relevance, note }) {
  const s = load();
  const row = s.rows.find((r) => r.id === rowId);
  if (!row) throw new Error('No such row.');
  if (relevance !== undefined) {
    const options = relevanceOptions(s);
    if (!options.includes(relevance)) throw new Error(`Relevance must be one of ${options.join(', ')}.`);
    row.relevance = relevance;
  }
  if (note !== undefined) row.note = String(note).slice(0, 2000);
  row.markedAt = new Date().toISOString();
  save(s);
  return row;
}

/** Ask the model again about one row — after changing the prompt, usually. */
export async function reask(rowId, prompt) {
  const s = load();
  const row = s.rows.find((r) => r.id === rowId);
  if (!row) throw new Error('No such row.');
  const text = String(prompt || row.prompt || s.prompt || DEFAULT_PROMPT).trim();

  // A row from a job that did not qualify has nothing but its card, so there
  // is nothing worth asking about yet: read the profile first. That is a page
  // load, so it goes through the queue like any other.
  if (!row.summary && !(row.positions || []).length) {
    // Record the wait, so a poll that lands before the queue picks this up
    // does not put the row back to how it looked.
    upsertRow({ id: rowId, status: 'reading', error: null });
    enqueue({ kind: 'qualify', rowId, prompt: text, label: `Qualifying ${row.name}` });
    return { ...row, status: 'reading' };
  }

  const answer = await ask(row, text);
  const fresh = load();
  const target = fresh.rows.find((r) => r.id === rowId);
  if (target) Object.assign(target, answer, { prompt: text, qualified: !answer.error });
  fresh.prompt = text;
  save(fresh);
  return target;
}

/** One row: read the profile, then put it to the model. */
async function runQualify(job) {
  const row = load().rows.find((r) => r.id === job.rowId);
  if (!row) return;
  upsertRow({ id: row.id, status: 'reading' });
  note(`Reading ${row.name}…`);

  let profile;
  try {
    profile = await agent.readProfileDetail(row.url);
  } catch (err) {
    upsertRow({ id: row.id, status: 'error', error: `Could not read the profile: ${err.message}` });
    return;
  }

  const filled = {
    ...row,
    name: profile.name || row.name,
    headline: profile.headline || row.headline,
    company: profile.company || companyFrom(profile.headline) || row.company || '',
    summary: profile.summary || '',
    positions: profile.positions || [],
    experienceText: profile.experienceText || '',
    status: 'asking',
  };
  upsertRow(filled);

  const answered = await ask(filled, job.prompt);
  upsertRow({
    ...filled,
    ...answered,
    prompt: job.prompt,
    qualified: !answered.error,
    status: answered.error ? 'error' : 'done',
  });
  note(`${filled.name}: ${answered.error ? answered.error : firstLine(answered.answer)}`);
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
      currentKind = job.kind;
      stopping = false;
      try {
        if (job.kind === 'introducer') await runIntroducer(job);
        else if (job.kind === 'odds') await runOdds(job);
        else if (job.kind === 'qualify') await runQualify(job);
        else await runJob(job);
      } catch (err) {
        note(`${job.label}: ${err.message}`);
        markFailed(job, err.message);
      }
      current = null;
      currentKind = null;
    }
  } finally {
    running = false;
    current = null;
    currentKind = null;
    stopping = false;
    inFlight = null;
  }
}

function markFailed(job, message) {
  const s = load();
  if (job.kind === 'odds') {
    note(`Estimating stopped: ${message}`);
    return;
  }
  if (job.kind === 'qualify') {
    const row = s.rows.find((r) => r.id === job.rowId);
    if (row) Object.assign(row, { status: 'error', error: message });
    save(s);
    return;
  }
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
    shouldStop: stopRequested,
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
  if (stopRequested()) {
    note(`Stopped ${jobLabel(entry)} before it read anyone.`);
    patchJob({ status: 'stopped', lastRunAt: new Date().toISOString() });
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

  const seen = alreadyChecked(entry.id);
  let carried = 0;

  for (const target of targets) {
    if (stopRequested()) {
      note(`Stopped ${jobLabel(entry)} — ${load().rows.filter((r) => r.jobId === entry.id).length} kept.`);
      patchJob({
        status: 'stopped',
        lastRunAt: new Date().toISOString(),
        found: load().rows.filter((r) => r.jobId === entry.id).length,
      });
      return;
    }
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
    // Not qualifying: the card is the whole row. No profile load, no model.
    if (entry.qualify === false) {
      upsertRow({ ...row, status: 'done', answer: '', qualified: false });
      continue;
    }

    // Checked out already, under another connection: take what is known
    // rather than loading the profile and asking about them a second time.
    const before = seen.find(target.name, target.headline, shortUrl(target.url));
    if (before) {
      carried++;
      upsertRow({
        ...row,
        title: before.title || row.title,
        headline: before.headline || row.headline,
        company: before.company || '',
        summary: before.summary || '',
        positions: before.positions || [],
        experienceText: before.experienceText || '',
        answer: before.answer,
        model: before.model,
        prompt: before.prompt,
        // No new spend: this row is a copy of work already paid for.
        cost: 0,
        usage: null,
        carriedFrom: { jobId: before.jobId, introducerName: before.introducerName, at: before.answeredAt || before.at },
        error: null,
        status: 'done',
      });
      note(`${row.name}: already checked via ${before.introducerName} — carried over.`);
      continue;
    }

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
    upsertRow({
      ...row,
      ...answered,
      prompt: entry.prompt,
      qualified: !answered.error,
      status: answered.error ? 'error' : 'done',
    });
    note(`${row.name}: ${answered.error ? answered.error : firstLine(answered.answer)}`);
  }

  if (carried) note(`${carried} of ${targets.length} were already checked elsewhere and were not re-read.`);
  patchJob({
    status: 'done',
    error: null,
    skipped: null,
    carried,
    lastRunAt: new Date().toISOString(),
    found: load().rows.filter((r) => r.jobId === entry.id).length,
  });
}

/** "General Partner at Google Ventures" — the firm is what follows "at". */
const companyFrom = (headline) => String(headline || '').split(/\bat\b/i).slice(1).join(' at ').trim();

const firstLine = (t) => String(t || '').split('\n')[0].slice(0, 120);

/**
 * Who a row is about, for spotting someone already looked at: their name and
 * the title on their card, which is how you would recognise them yourself.
 * The profile URL counts too — same link, same person, whatever it reads as.
 */
const personKey = (name, title) =>
  `${normalise(name)}|${normalise(title)}`.replace(/\s+/g, ' ').trim();

/** Rows already checked out, from every job but this one. */
function alreadyChecked(exceptJobId) {
  const byKey = new Map();
  const byUrl = new Map();
  for (const r of load().rows) {
    // A re-run refreshes its own rows; only other jobs count as "already".
    if (r.jobId === exceptJobId) continue;
    if (r.status !== 'done' || !r.answer) continue;
    const key = personKey(r.name, r.title || r.headline);
    if (key.replace('|', '').trim() && !byKey.has(key)) byKey.set(key, r);
    if (r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  return {
    find: (name, title, url) => (url && byUrl.get(url)) || byKey.get(personKey(name, title)) || null,
    size: byKey.size,
  };
}

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
    inFlight = new AbortController();
    const result = await askLLM(client, {
      system: DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: renderPrompt(prompt, row) }],
      settings: s,
      signal: inFlight.signal,
    });
    inFlight = null;
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
    inFlight = null;
    return { answer: '', error: stopRequested() ? 'Stopped before an answer came back.' : err.message };
  }
}

// --------------------------------------------- everyone, across every job

/**
 * The rows merged into one person each. Reached through two connections is
 * one person with two ways in, not two rows — and the whole point of the view
 * is seeing which of your connections can make the introduction.
 *
 * Your own marks travel with the person: a relevance or note set on any of
 * their rows shows on all of them, since it was a judgement about them rather
 * than about the path.
 */
export function people() {
  const s = load();
  const jobs = new Map(s.jobs.map((j) => [j.id, j]));
  const byKey = new Map();

  for (const row of s.rows) {
    // Name and title first, as that is what makes two entries the same person
    // to you — the same person can carry two profile URLs. The link is the
    // fallback for anyone whose card gave no title.
    const named = personKey(row.name, row.title || row.headline);
    const key = named.replace('|', '').trim() ? named : row.url;
    let person = byKey.get(key);
    if (!person) {
      person = {
        key,
        name: row.name,
        title: row.title || row.headline || '',
        company: row.company || '',
        url: row.url,
        degree: row.degree || null,
        answer: '',
        odds: '',
        relevance: '',
        note: '',
        via: [],
        rowIds: [],
        // Whether one of their rows is being read or asked about right now,
        // so the view can say so rather than looking idle.
        working: false,
        error: '',
        firstSeen: row.at || null,
      };
      byKey.set(key, person);
    }

    person.rowIds.push(row.id);
    // Whichever row knows more fills the gaps.
    person.title = person.title || row.title || row.headline || '';
    person.company = person.company || row.company || '';
    person.answer = person.answer || row.answer || '';
    person.odds = person.odds || row.odds || '';
    person.degree = person.degree || row.degree || null;
    // A mark you made anywhere is the mark on the person.
    if (!person.relevance || person.relevance === RELEVANCE[0]) person.relevance = row.relevance || person.relevance;
    person.note = person.note || row.note || '';
    if (row.status === 'reading' || row.status === 'asking') person.working = row.status;
    if (!person.answer && row.error) person.error = row.error;

    const name = row.introducerName || jobs.get(row.jobId)?.introducerName;
    if (name && !person.via.some((v) => v.name === name)) {
      person.via.push({ name, url: row.introducerUrl || '', term: row.term || jobs.get(row.jobId)?.term || '' });
    }
  }

  return [...byKey.values()].sort((a, b) => b.via.length - a.via.length || a.name.localeCompare(b.name));
}

/**
 * Ask how likely each of these people is to be an investor, from their title.
 * Queued like everything else, so it is paced, visible, and stoppable.
 */
export function estimateOdds(groups) {
  const lists = (groups || []).map((g) => [].concat(g)).filter((g) => g.length);
  if (!lists.length) throw new Error('Nobody to estimate.');
  enqueue({
    kind: 'odds',
    groups: lists,
    label: `Estimating likelihood for ${lists.length} ${lists.length === 1 ? 'person' : 'people'}`,
  });
  return status();
}

const ODDS_SYSTEM =
  'You judge whether someone is a professional investor — a VC, angel, LP, or someone whose job is ' +
  'deploying capital — from what their LinkedIn headline says they do. Operators, founders, ' +
  'recruiters and advisors are not investors unless the title says they also invest.';

async function runOdds(job) {
  let done = 0;
  for (const rowIds of job.groups) {
    if (stopRequested()) {
      note(`Stopped estimating — ${done} of ${job.groups.length} done.`);
      return;
    }

    const s = load();
    const rows = job.groups.length ? s.rows.filter((r) => rowIds.includes(r.id)) : [];
    const row = rows[0];
    if (!row) continue;

    const settingsNow = settings();
    if (!settingsNow.apiKey) {
      note('No Anthropic API key — add one on the Settings tab.');
      return;
    }

    const title = row.title || row.headline || '';
    let value;
    let usage = null;
    try {
      inFlight = new AbortController();
      const result = await chooseValue(makeClient(settingsNow.apiKey), {
        system: ODDS_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `Name: ${row.name}\n` +
              `Title: ${title || '(none given)'}\n` +
              (row.company ? `Company: ${row.company}\n` : '') +
              '\nHow likely is it that this person is an investor?',
          },
        ],
        settings: settingsNow,
        column: 'Likelihood they are an investor',
        values: ODDS,
        signal: inFlight.signal,
      });
      inFlight = null;
      value = result.value;
      usage = result.usage;
    } catch (err) {
      inFlight = null;
      note(`${row.name}: could not estimate — ${stopRequested() ? 'stopped' : err.message}`);
      if (stopRequested()) return;
      continue;
    }

    // The estimate is about the person, so it goes on every row that is them.
    const cost = costOf(settingsNow.model, usage) || 0;
    const fresh = load();
    let first = true;
    for (const r of fresh.rows) {
      if (!rowIds.includes(r.id)) continue;
      r.odds = value;
      // Charge it once, not once per path.
      if (first) r.oddsCost = cost;
      first = false;
    }
    save(fresh);
    done++;
    note(`${row.name}: ${value}${title ? ` — "${title}"` : ''}`);
  }
  note(`Estimated ${done} of ${job.groups.length}.`);
}

/**
 * Read and ask about several people at once. One queue entry each, so the
 * count of what is waiting is honest and Stop job ends it where it stands.
 */
export function qualifyMany(rowIds) {
  const ids = [].concat(rowIds || []);
  const s = load();
  const queued = [];
  for (const id of ids) {
    const row = s.rows.find((r) => r.id === id);
    if (!row || row.answer) continue;
    upsertRow({ id: row.id, status: 'reading', error: null });
    enqueue({
      kind: 'qualify',
      rowId: row.id,
      prompt: row.prompt || s.prompt || DEFAULT_PROMPT,
      label: `Qualifying ${row.name}`,
    });
    queued.push(row.name);
  }
  if (!queued.length) throw new Error('Everyone showing has been qualified already.');
  note(`Qualifying ${queued.length} ${queued.length === 1 ? 'person' : 'people'}…`);
  return status();
}

/** Set relevance or a note on a person, which means on every row for them. */
export function markPerson(rowIds, fields) {
  const ids = [].concat(rowIds || []);
  if (!ids.length) throw new Error('No rows to mark.');
  let last = null;
  for (const id of ids) {
    try {
      last = markRow(id, fields);
    } catch {
      // A row deleted since the view was drawn is not worth failing over.
    }
  }
  if (!last) throw new Error('Those rows are gone — reload the tab.');
  return last;
}

/** What the rows cost to answer, all together. */
export const totalCost = () => load().rows.reduce((sum, r) => sum + (r.cost || 0) + (r.oddsCost || 0), 0);

/**
 * The queue lives in memory, so a restart leaves jobs on disk claiming to be
 * queued or running with nothing behind them. Say what actually happened,
 * rather than leaving them waiting for a turn that will never come.
 */
function reconcileOnStart() {
  const s = load();
  let stranded = 0;
  for (const job of s.jobs) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    Object.assign(job, { status: 'stopped', error: 'Interrupted when the app restarted — run it again.' });
    stranded++;
  }
  // A row stuck mid-read is in the same position: put it back to where the
  // Qualify button can pick it up again.
  let rows = 0;
  for (const row of s.rows) {
    if (row.status !== 'reading' && row.status !== 'asking') continue;
    Object.assign(row, { status: 'done', error: null });
    rows++;
  }

  if (!stranded && !rows) return;
  if (stranded) {
    note(
      `${stranded} job${stranded === 1 ? ' was' : 's were'} interrupted when the app last stopped — run again to pick up.`
    );
  }
  save(s);
}

reconcileOnStart();
