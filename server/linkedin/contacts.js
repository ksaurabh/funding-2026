// The contact book the agent builds up, plus the queue that fills it.
import crypto from 'node:crypto';
import { read, write } from '../store.js';
import * as agent from './agent.js';
import * as network from './network.js';

const LAST_KEY = 'linkedin-last';

const KEY = 'contacts';
const keyOf = (name, company) => `${name}|${company}`.toLowerCase().replace(/\s+/g, ' ').trim();

export const all = () => read(KEY, []);

/** The person most recently searched for, so it can be repeated in one click. */
export const lastSearch = () => read(LAST_KEY, null);

/**
 * Find the contact a result belongs to. Identity is, in order: the contact
 * being re-run, the LinkedIn profile itself, what was typed into the search,
 * and only then the name and company as read back — which drift between runs,
 * because the profile's own wording is not what you searched for.
 */
function indexOfContact(list, record) {
  const byId = record.id ? list.findIndex((c) => c.id === record.id) : -1;
  if (byId >= 0) return byId;

  if (record.url) {
    const byUrl = list.findIndex((c) => c.url && c.url === record.url);
    if (byUrl >= 0) return byUrl;
  }

  const asked = keyOf(record.queriedAs || record.name, record.queriedCompany ?? record.company);
  const byQuery = list.findIndex((c) => keyOf(c.queriedAs || c.name, c.queriedCompany ?? c.company) === asked);
  if (byQuery >= 0) return byQuery;

  return list.findIndex((c) => keyOf(c.name, c.company) === keyOf(record.name, record.company));
}

export function upsert(record) {
  const list = all();
  const i = indexOfContact(list, record);
  const merged = {
    strength: null,
    notes: '',
    ...(i >= 0 ? list[i] : {}),
    ...record,
    updatedAt: new Date().toISOString(),
  };
  // After the spreads: a record carrying `id: undefined` would otherwise
  // erase the id it is meant to update.
  merged.id = record.id || (i >= 0 ? list[i].id : crypto.randomUUID().slice(0, 8));
  if (i >= 0) list[i] = merged;
  else list.push(merged);
  write(KEY, list);
  return merged;
}

export function patch(id, fields) {
  const list = all();
  const c = list.find((x) => x.id === id);
  if (!c) return null;
  if ('strength' in fields) {
    const n = Number(fields.strength);
    c.strength = fields.strength === null || fields.strength === '' ? null : Math.max(1, Math.min(10, n)) || null;
  }
  if (typeof fields.notes === 'string') c.notes = fields.notes;
  c.updatedAt = new Date().toISOString();
  write(KEY, list);
  return c;
}

/**
 * Forget a lookup, and the pages cached for it — leaving those behind would
 * just fill the cache with screenshots nothing refers to.
 */
export function remove(ids) {
  const wanted = new Set([].concat(ids));
  const list = all();
  const going = list.filter((c) => wanted.has(c.id));

  for (const c of going) {
    const files = [...(c.shots || []).flatMap((s) => [s.file, s.html]), c.html, c.mutualPage?.html];
    for (const f of files) if (f) agent.removeCachedPage(f);
  }

  write(KEY, list.filter((c) => !wanted.has(c.id)));
  return going.length;
}

// ------------------------------------------------------------------- queue
// One lookup at a time: a second browser tab racing the first would get us
// rate-limited, and the window is visible so you can watch it work.

let queue = [];
let running = false;
let log = [];
let current = null;
// A running account of what the agent is doing and what it is reading, so the
// UI can show the work rather than just the outcome.
let activity = [];

const note = (msg) => {
  log.push({ t: new Date().toISOString(), msg });
  if (log.length > 400) log.splice(0, log.length - 400);
};

const record = (event) => {
  activity.push({ t: new Date().toISOString(), ...event });
  if (activity.length > 60) activity.splice(0, activity.length - 60);
};

export const queueStatus = () => ({
  running,
  current,
  pending: queue.map((q) => ({ name: q.name, company: q.company })),
  log: log.slice(-200),
  activity: activity.slice(-30),
  last: lastSearch(),
});

export function enqueue(items) {
  const added = items
    .map((i) => ({
      name: String(i.name || '').trim(),
      company: String(i.company || '').trim(),
      // A known profile address skips the search entirely.
      url: String(i.url || '').trim() || null,
      // Set when re-running a contact, so the result updates that row.
      contactId: i.contactId || null,
    }))
    .filter((i) => i.name);
  // Give every queued lookup a row at once, so it is visible as pending
  // rather than appearing only when it finishes.
  for (const item of added) {
    const row = upsert({
      id: item.contactId || undefined,
      queriedAs: item.name,
      queriedCompany: item.company,
      url: item.url || undefined,
      name: item.name,
      company: item.company,
      status: 'queued',
    });
    item.contactId = row.id;
  }

  queue.push(...added);
  if (added.length) note(`Queued ${added.length} lookup${added.length === 1 ? '' : 's'}.`);
  void drain();
  return added.length;
}

/** Restart the queue after it stopped for a closed or signed-out browser. */
export function resumeQueue() {
  if (!running && queue.length) {
    note(`Resuming ${queue.length} queued lookup${queue.length === 1 ? '' : 's'}.`);
    void drain();
  }
  return queueStatus();
}

export function clearQueue() {
  const n = queue.length;
  queue = [];
  if (n) note(`Dropped ${n} queued lookup${n === 1 ? '' : 's'}.`);
  return n;
}

/**
 * Make sure there is a signed-in browser before the first lookup runs.
 * Queueing a name is the instruction; opening the window is this job, not
 * something to be asked about first.
 */
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
      // Checked per item: the window can be closed or signed out mid-batch.
      if (!(await ensureSession())) {
        note(`Paused — no signed-in LinkedIn session. ${queue.length} lookup${queue.length === 1 ? '' : 's'} waiting.`);
        break;
      }
      const item = queue.shift();
      current = item;
      note(
        `Looking up ${item.name}` +
          (item.url ? ' · by profile link' : item.company ? ` · ${item.company}` : '') +
          '…'
      );
      write(LAST_KEY, { name: item.name, company: item.company, at: new Date().toISOString() });
      const startedAt = Date.now();
      // Each lookup gets its own slate; the previous one stays on the contact.
      activity = [];
      record({ type: 'start', name: item.name, company: item.company });

      const patchRow = (fields) =>
        upsert({ id: item.contactId, queriedAs: item.name, queriedCompany: item.company, ...fields });

      patchRow({ status: 'running', ranAt: new Date().toISOString(), stage: 'searching' });

      // Each stage lands on the contact as it happens, so its detail fills in
      // while the agent is still working rather than all at the end.
      const onEvent = (e) => {
        record(e);
        if (e.type === 'results') patchRow({ candidates: e.top, stage: 'scoring' });
        else if (e.type === 'accepted') patchRow({ confidence: e.confidence, stage: 'opening the profile' });
        else if (e.type === 'profile') {
          const p = e.profile;
          patchRow({
            name: p.name || item.name,
            company: p.company || item.company,
            headline: p.headline,
            url: p.url,
            degree: p.degree,
            stage: p.degree === '2nd' ? 'reading mutual connections' : 'finishing',
          });
        } else if (e.type === 'shared-page') {
          patchRow({ via: e.people, stage: `mutual connections, page ${e.page} (${e.total} so far)` });
        }
      };

      try {
        const result = await agent.findPerson({ ...item, onEvent });
        if (!result.found) {
          note(`✗ ${item.name}: ${result.reason}`);
          upsert({
            id: item.contactId || undefined,
            queriedAs: item.name,
            queriedCompany: item.company,
            tookMs: Date.now() - startedAt,
            stage: null,
            name: item.name,
            company: item.company,
            degree: null,
            url: null,
            confidence: result.candidates?.[0]?.confidence ?? null,
            status: 'not found',
            reason: result.reason,
            via: [],
            // Kept so the near-misses can be reviewed later.
            candidates: result.candidates || [],
            shots: result.shots || [],
            html: result.html || null,
          });
        } else {
          const p = result.person;
          upsert({
            id: item.contactId || undefined,
            queriedAs: item.name,
            queriedCompany: item.company,
            tookMs: Date.now() - startedAt,
            stage: null,
            name: p.name,
            company: p.company || item.company,
            headline: p.headline,
            url: p.url,
            degree: p.degree,
            via: p.via,
            mutualText: p.mutualText || null,
            mutualPage: p.mutualPage || null,
            confidence: result.confidence,
            status: 'found',
            reason: null,
            candidates: result.candidates || [],
            shots: result.shots || [],
          });
          // A lookup started from someone in your network refreshes them.
          if (item.url) {
            network.refreshByUrl(item.url, {
              name: p.name,
              headline: p.headline,
              company: p.company,
              degree: p.degree,
            });
          }

          note(
            `✓ ${p.name} — ${p.degree || 'degree unknown'}` +
              (p.via.length ? `, ${p.via.length} shared connection${p.via.length === 1 ? '' : 's'}` : '') +
              ` (${Math.round(result.confidence * 100)}% confident)`
          );
        }
      } catch (err) {
        record({ type: 'error', message: err.message });
        if (!/not open|not signed in/i.test(err.message)) {
          patchRow({ status: 'failed', stage: null, reason: err.message, tookMs: Date.now() - startedAt });
        } else {
          patchRow({ status: 'queued', stage: null });
        }
        // A closed browser or a sign-out stops the batch rather than grinding
        // through it failing every time — and the lookup goes back on the
        // queue, since nothing was actually attempted.
        if (/not open|not signed in/i.test(err.message)) {
          queue.unshift(item);
          current = null;
          note(
            `Paused — ${err.message} ${queue.length} lookup${queue.length === 1 ? '' : 's'} waiting for a session.`
          );
          break;
        }
        note(`✗ ${item.name}: ${err.message}`);
      }
      current = null;
      if (queue.length) await agent.pauseBetweenLookups();
    }
  } finally {
    running = false;
    current = null;
  }
}
