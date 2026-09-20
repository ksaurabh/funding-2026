// The contact book the agent builds up, plus the queue that fills it.
import crypto from 'node:crypto';
import { read, write } from '../store.js';
import * as agent from './agent.js';

const LAST_KEY = 'linkedin-last';

const KEY = 'contacts';
const keyOf = (name, company) => `${name}|${company}`.toLowerCase().replace(/\s+/g, ' ').trim();

export const all = () => read(KEY, []);

/** The person most recently searched for, so it can be repeated in one click. */
export const lastSearch = () => read(LAST_KEY, null);

export function upsert(record) {
  const list = all();
  const i = list.findIndex(
    (c) => c.id === record.id || keyOf(c.name, c.company) === keyOf(record.name, record.company)
  );
  const merged = {
    id: record.id || (i >= 0 ? list[i].id : crypto.randomUUID().slice(0, 8)),
    strength: null,
    notes: '',
    ...(i >= 0 ? list[i] : {}),
    ...record,
    updatedAt: new Date().toISOString(),
  };
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

export function remove(id) {
  write(KEY, all().filter((c) => c.id !== id));
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
    .map((i) => ({ name: String(i.name || '').trim(), company: String(i.company || '').trim() }))
    .filter((i) => i.name);
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

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      current = item;
      note(`Looking up ${item.name}${item.company ? ` · ${item.company}` : ''}…`);
      write(LAST_KEY, { ...item, at: new Date().toISOString() });
      // Each lookup gets its own slate; the previous one stays on the contact.
      activity = [];
      record({ type: 'start', name: item.name, company: item.company });
      try {
        const result = await agent.findPerson({ ...item, onEvent: record });
        if (!result.found) {
          note(`✗ ${item.name}: ${result.reason}`);
          upsert({
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
          });
        } else {
          const p = result.person;
          upsert({
            name: p.name,
            company: p.company || item.company,
            headline: p.headline,
            url: p.url,
            degree: p.degree,
            via: p.via,
            mutualText: p.mutualText || null,
            confidence: result.confidence,
            status: 'found',
            reason: null,
            queriedAs: item.name,
            candidates: result.candidates || [],
            shots: result.shots || [],
          });
          note(
            `✓ ${p.name} — ${p.degree || 'degree unknown'}` +
              (p.via.length ? `, ${p.via.length} shared connection${p.via.length === 1 ? '' : 's'}` : '') +
              ` (${Math.round(result.confidence * 100)}% confident)`
          );
        }
      } catch (err) {
        record({ type: 'error', message: err.message });
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
