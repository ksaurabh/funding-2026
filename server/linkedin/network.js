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

export function patch(id, fields) {
  const list = all();
  const p = list.find((x) => x.id === id);
  if (!p) return null;

  if ('strength' in fields) {
    const n = Number(fields.strength);
    p.strength = fields.strength === null || fields.strength === '' ? null : Math.max(1, Math.min(5, n)) || null;
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
