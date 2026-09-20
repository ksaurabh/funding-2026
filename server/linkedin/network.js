// The people you know directly — your own network, built up from the mutual
// connections found on the contacts you look up.
//
// A contact is someone you are trying to reach. A network entry is someone
// who could introduce you: first-degree, scored for how well you know them
// (strength, 1-5) and ordered by how willing you are to ask (rank).
import crypto from 'node:crypto';
import { read, write } from '../store.js';

const KEY = 'network';
const keyOf = (url, name) => (url || `name:${name}`).toLowerCase().replace(/\/+$/, '');

export const all = () => read(KEY, []);

/**
 * Add people, keeping who they were found through. Someone already in the
 * list keeps their strength and rank and gains the new source.
 */
export function add(people, source) {
  const list = all();
  const byKey = new Map(list.map((p) => [keyOf(p.url, p.name), p]));
  let added = 0;
  let merged = 0;

  for (const p of people) {
    const name = String(p?.name || '').trim();
    if (!name) continue;
    const k = keyOf(p.url, name);
    const existing = byKey.get(k);

    if (existing) {
      existing.headline = existing.headline || p.headline || '';
      existing.photo = existing.photo || p.photo || null;
      if (source && !existing.sources.some((s) => s.id === source.id)) existing.sources.push(source);
      existing.updatedAt = new Date().toISOString();
      merged++;
      continue;
    }

    const entry = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      url: p.url || null,
      headline: p.headline || '',
      photo: p.photo || null,
      strength: null, // 1-5, how well you know them
      strengthSource: null, // 'you' when you set it, 'derived' when computed
      shared: null, // connections you and they have in common
      rank: null, // your own ordering; lower is nearer the top
      notes: '',
      sources: source ? [source] : [], // the contacts they are a path to
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    list.push(entry);
    byKey.set(k, entry);
    added++;
  }

  write(KEY, list);
  return { added, merged, total: list.length };
}

/**
 * Fold what a lookup learned back into the network entry: their real title,
 * photo and confirmed degree. Rank, strength and notes are yours and are
 * never touched.
 */
export function refreshByUrl(url, fields) {
  if (!url) return null;
  const list = all();
  const k = keyOf(url, '');
  const p = list.find((x) => keyOf(x.url, x.name) === k);
  if (!p) return null;

  if (fields.name) p.name = fields.name;
  if (fields.headline) p.headline = fields.headline;
  if (fields.company) p.company = fields.company;
  if (fields.photo) p.photo = fields.photo;
  if (fields.degree) p.degree = fields.degree;
  if (Number.isFinite(fields.shared)) p.shared = fields.shared;
  p.checkedAt = new Date().toISOString();
  p.updatedAt = p.checkedAt;

  write(KEY, list);
  return p;
}

/**
 * Bring the network up to date from lookups already on disk — no LinkedIn.
 *
 * Two things drift. A person added early holds whatever the search card said
 * about them, which a later, fuller fetch improves on. And a path found after
 * they were added is not recorded against them: if you add someone through
 * one investor and later look up a second who shares them, nothing links the
 * two until now.
 */
export function resyncFrom(contacts) {
  const list = all();
  const byKey = new Map(list.map((p) => [keyOf(p.url, p.name), p]));
  let details = 0;
  let paths = 0;

  for (const c of contacts) {
    const source = { id: c.id, name: c.name };
    for (const person of c.via || []) {
      const entry = byKey.get(keyOf(person.url, person.name));
      if (!entry) continue; // not in the network; adding is a separate choice

      let touched = false;
      // Prefer a longer headline: the profile's wording beats a truncated card.
      if (person.headline && person.headline.length > (entry.headline || '').length) {
        entry.headline = person.headline;
        touched = true;
      }
      if (person.photo && person.photo !== entry.photo) {
        entry.photo = person.photo;
        touched = true;
      }
      if (person.url && !entry.url) {
        entry.url = person.url;
        touched = true;
      }
      if (touched) details++;

      if (!entry.sources.some((s) => s.id === source.id)) {
        entry.sources.push(source);
        paths++;
        touched = true;
      }
      if (touched) entry.updatedAt = new Date().toISOString();
    }
  }

  if (details || paths) write(KEY, list);
  return { details, paths, people: list.length };
}

export function patch(id, fields) {
  const list = all();
  const p = list.find((x) => x.id === id);
  if (!p) return null;

  if ('strength' in fields) {
    const n = Number(fields.strength);
    p.strength = fields.strength === null || fields.strength === '' ? null : Math.max(1, Math.min(5, n)) || null;
    // Set by hand: a later refresh must not silently overwrite it.
    p.strengthSource = p.strength === null ? null : 'you';
  }
  if ('rank' in fields) {
    const n = Number(fields.rank);
    p.rank = fields.rank === null || fields.rank === '' || Number.isNaN(n) ? null : Math.round(n);
  }
  if (typeof fields.notes === 'string') p.notes = fields.notes;

  p.updatedAt = new Date().toISOString();
  write(KEY, list);
  return p;
}

/**
 * How many shared connections each star is worth. Round numbers, chosen to
 * spread a typical network rather than derived from anything — which is why
 * a rating you set by hand always wins.
 */
const STRENGTH_BANDS = [
  [100, 5],
  [50, 4],
  [20, 3],
  [5, 2],
  [0, 1],
];

export const strengthFromShared = (n) =>
  Number.isFinite(n) ? STRENGTH_BANDS.find(([floor]) => n >= floor)[1] : null;

/**
 * Re-derive strength from the shared-connection counts already fetched.
 * Only fills in ratings that are unset or were themselves derived; anything
 * you set by hand is left alone.
 */
export function refreshStrength({ overwrite = false, contacts = [] } = {}) {
  const list = all();
  let set = 0;
  let kept = 0;
  let missing = 0;

  // The shared-connection count is recorded on the contact when they are
  // looked up. Someone added to the network afterwards never received it, so
  // pull it across before deriving anything.
  const byKey = new Map(list.map((p) => [keyOf(p.url, p.name), p]));
  for (const c of contacts) {
    const claimed = c.mutualPage?.claimed;
    if (!Number.isFinite(claimed) || !c.url) continue;
    const entry = byKey.get(keyOf(c.url, c.name));
    if (entry && entry.shared !== claimed) {
      entry.shared = claimed;
      if (c.degree) entry.degree = c.degree;
      entry.updatedAt = new Date().toISOString();
    }
  }

  for (const p of list) {
    if (!Number.isFinite(p.shared)) {
      missing++;
      continue;
    }
    if (p.strengthSource === 'you' && !overwrite) {
      kept++;
      continue;
    }
    const next = strengthFromShared(p.shared);
    if (p.strength !== next || p.strengthSource !== 'derived') {
      p.strength = next;
      p.strengthSource = 'derived';
      p.updatedAt = new Date().toISOString();
      set++;
    }
  }

  if (set) write(KEY, list);
  return { set, kept, missing, people: list.length };
}

export function remove(ids) {
  const wanted = new Set([].concat(ids));
  const list = all();
  const kept = list.filter((p) => !wanted.has(p.id));
  write(KEY, kept);
  return list.length - kept.length;
}

/** Renumber ranks 1..n in their current order, closing any gaps. */
export function renumber(orderedIds) {
  const list = all();
  orderedIds.forEach((id, i) => {
    const p = list.find((x) => x.id === id);
    if (p) p.rank = i + 1;
  });
  write(KEY, list);
  return list;
}
