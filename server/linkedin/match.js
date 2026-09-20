// Deciding whether a search result really is the person we asked for.
//
// Kept apart from the browser so it can be reasoned about and tested on its
// own: given a query and a result card, how sure are we?

const STOP_WORDS = new Set([
  'inc', 'inc.', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'the', 'group', 'holdings', 'partners', 'capital', 'ventures', 'vc', 'lp', 'llp',
  'gmbh', 'sa', 'ag', 'bv', 'plc', 'pte', 'pvt', 'technologies', 'labs',
]);

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalise(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s, drop = new Set()) => normalise(s).split(' ').filter((t) => t && !drop.has(t));

/** Overlap of two token sets, 0..1, measured against the smaller set. */
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hits = a.filter((t) => setB.has(t)).length;
  return hits / Math.min(a.length, b.length);
}

/**
 * How well a name matches. Requires every part of the queried name to appear,
 * so "John Smith" does not match "John Smithson" or a different John.
 */
export function nameScore(query, candidate) {
  const q = tokens(query);
  const c = tokens(candidate);
  if (!q.length || !c.length) return 0;

  const matched = q.filter((t) => c.includes(t));
  if (matched.length !== q.length) {
    // Allow one initial to stand in for a first name: "J Smith" vs "John Smith".
    const loose = q.filter((t) => c.includes(t) || (t.length === 1 && c.some((x) => x.startsWith(t))));
    if (loose.length !== q.length) return overlap(q, c) * 0.6;
  }
  // Exact set match scores highest; extra middle names cost a little.
  const extra = Math.max(0, c.length - q.length);
  return Math.max(0, 1 - extra * 0.05);
}

/** Company match, ignoring the noise words that pad legal names. */
export function companyScore(query, candidateText) {
  const q = tokens(query, STOP_WORDS);
  const c = tokens(candidateText, STOP_WORDS);
  if (!q.length) return null; // nothing asked for
  if (!c.length) return 0;
  const o = overlap(q, c);
  // A single shared distinctive token is usually enough ("Accel" in "Accel Partners").
  return o >= 0.99 ? 1 : o;
}

/**
 * Confidence that `result` is the person described by `query`.
 * Name carries most of the weight; company confirms it.
 */
export function confidenceOf(query, result) {
  const name = nameScore(query.name, result.name);
  const company = companyScore(query.company, [result.headline, result.company].filter(Boolean).join(' '));

  // With no company to check against, a name alone can never reach certainty.
  if (company === null) return { confidence: Math.min(0.85, name), nameScore: name, companyScore: null };

  return { confidence: name * 0.65 + company * 0.35, nameScore: name, companyScore: company };
}

/** Best candidate, and whether it clears the bar. */
export function pickBest(query, results, threshold = 0.9) {
  const scored = results
    .map((r) => ({ ...r, ...confidenceOf(query, r) }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = scored[0] || null;
  return {
    best,
    accepted: !!best && best.confidence >= threshold,
    runnerUp: scored[1] || null,
    all: scored,
  };
}
