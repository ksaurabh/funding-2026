// The LinkedIn agent: one real Chrome window, driven slowly, using your own
// logged-in session.
//
// Nothing here logs you in — you do that yourself in the window it opens, and
// the session is kept in a profile directory so you only do it once. Actions
// are paced deliberately: this is a research assistant working at human speed,
// not a scraper.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { DATA_DIR } from '../store.js';
import { SELECTORS, findOne, findAll, textOf } from './selectors.js';
import { extractPeopleInPage, extractProfileInPage } from './extract.js';
import { pickBest } from './match.js';

const PROFILE_DIR = path.join(DATA_DIR, 'linkedin-profile');
export const SHOTS_DIR = path.join(DATA_DIR, 'linkedin-shots');
// Overridable only so the pipeline can be exercised against a stand-in page.
const BASE = process.env.LINKEDIN_BASE || 'https://www.linkedin.com';

// Pacing, in milliseconds. Deliberately unhurried.
const PACE = { betweenActions: [1200, 2600], settle: [400, 900], betweenLookups: [4000, 9000] };

// The gap before each page load. Drawn from an exponential rather than picked
// uniformly: a fixed interval, or an even spread, is a machine's signature.
// This is mostly short with an occasional long pause. The mean is set so the
// measured gap between page loads — this delay plus the settle after the
// previous one — lands in the 2-3s band.
const PAGE_DELAY_MEAN = 1900;
const PAGE_DELAY_MAX = 20000;

// A ceiling so a contact with thousands of shared connections cannot run all
// afternoon.
const MUTUAL_PAGE_LIMIT = 40;

/**
 * Result hrefs come back relative as often as absolute — and sometimes not at
 * all, when LinkedIn wires a link up as an overlay. A missing href must stay
 * null so the caller knows to click the element instead of navigating.
 */
const absolute = (href) => {
  if (!href || !href.trim()) return null;
  try {
    return new URL(href, BASE).toString();
  } catch {
    return null;
  }
};

/**
 * A profile's canonical address, without the tracking query LinkedIn appends.
 * Only for /in/ links — a search or facet URL is *all* query string, so
 * stripping it there would throw the destination away.
 */
const profileUrl = (href) => absolute(href)?.split('?')[0] ?? null;

const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo);
const wait = (range) => new Promise((r) => setTimeout(r, jitter(range)));

const pageDelay = () => Math.min(-PAGE_DELAY_MEAN * Math.log(1 - Math.random()), PAGE_DELAY_MAX);

/**
 * Every navigation goes through here: pause first, then load, then let the
 * page settle. Nothing should call page.goto directly — the pause is what
 * keeps the agent at a human pace.
 */
async function visit(url, opts = {}) {
  const waited = pageDelay();
  await new Promise((r) => setTimeout(r, waited));
  await page.goto(url, { waitUntil: 'domcontentloaded', ...opts });
  await wait(PACE.settle);
  return waited;
}

let ctx = null; // the persistent browser context
let page = null;

export const isOpen = () => !!ctx;

/**
 * Keep a picture of the page the agent just read. Cached on disk so a lookup
 * can be checked against what LinkedIn actually showed, long after the fact.
 */
async function capture(label) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const stem = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    await page.screenshot({ path: path.join(SHOTS_DIR, `${stem}.png`), fullPage: false });

    // The markup as rendered, so a lookup that read the page wrongly can be
    // worked out afterwards rather than guessed at.
    let html = null;
    try {
      fs.writeFileSync(path.join(SHOTS_DIR, `${stem}.html`), await page.content());
      html = `${stem}.html`;
    } catch {
      /* the picture alone is still useful */
    }

    prune();
    return { label, file: `${stem}.png`, html, url: page.url() };
  } catch {
    return null; // a capture is a nicety; never fail a lookup over one
  }
}

const CACHE_LIMIT = 150; // files, roughly the last 25 lookups

/** Keep the cache from growing without bound — LinkedIn pages are large. */
function prune() {
  try {
    const files = fs
      .readdirSync(SHOTS_DIR)
      .map((f) => ({ f, t: fs.statSync(path.join(SHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(CACHE_LIMIT)) fs.rmSync(path.join(SHOTS_DIR, f), { force: true });
  } catch {
    /* pruning is housekeeping; never let it break a lookup */
  }
}

/** Drop one cached page, by filename. */
export function removeCachedPage(file) {
  try {
    if (!file || file.includes('/') || file.includes('..')) return;
    fs.rmSync(path.join(SHOTS_DIR, file), { force: true });
  } catch {
    /* housekeeping */
  }
}

/** What is in the cache, newest first. */
export function cachedPages() {
  try {
    return fs
      .readdirSync(SHOTS_DIR)
      .map((f) => {
        const st = fs.statSync(path.join(SHOTS_DIR, f));
        return { file: f, bytes: st.size, at: new Date(st.mtimeMs).toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** Open the browser (or re-use the open one) and report whether you are signed in. */
export async function openSession() {
  if (ctx) return status();

  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', // your installed Chrome; nothing is downloaded
    headless: false, // you need to see it, and to log in
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.on('close', () => {
    ctx = null;
    page = null;
  });

  page = ctx.pages()[0] || (await ctx.newPage());
  await visit(`${BASE}/feed/`);
  return status();
}

export async function closeSession() {
  if (!ctx) return { open: false, loggedIn: false };
  await ctx.close().catch(() => {});
  ctx = null;
  page = null;
  return { open: false, loggedIn: false };
}

/**
 * LinkedIn's session cookie. Far more reliable than reading the page: the
 * shell markup differs between the feed, a profile and a search, and changes
 * often, but `li_at` is present exactly when you are signed in.
 */
async function hasAuthCookie() {
  try {
    const cookies = await ctx.cookies([BASE, 'https://www.linkedin.com']);
    return cookies.some((c) => c.name === 'li_at' && c.value);
  } catch {
    return false;
  }
}

export async function status() {
  if (!ctx || !page) return { open: false, loggedIn: false };
  try {
    const cookie = await hasAuthCookie();
    const domSaysIn = !!(await findOne(page, SELECTORS.loggedIn));
    const onLoginPage = /\/(login|checkpoint|uas\/login|signup)/.test(page.url());
    const loginForm = !!(await findOne(page, SELECTORS.loginForm));

    return {
      open: true,
      // The cookie settles it; the DOM is a fallback for anything that is not
      // really LinkedIn (a local stand-in, say).
      loggedIn: cookie || (domSaysIn && !onLoginPage && !loginForm),
      url: page.url(),
      detectedBy: cookie ? 'cookie' : domSaysIn ? 'page' : 'neither',
    };
  } catch {
    return { open: true, loggedIn: false };
  }
}

/**
 * Re-check after you say you have signed in: go to the feed and look again,
 * which also shakes out a stale tab left on a login page.
 */
export async function recheck() {
  if (!ctx || !page) return { open: false, loggedIn: false };
  try {
    await visit(`${BASE}/feed/`);
  } catch {
    /* whatever the tab is showing, still report on it */
  }
  return status();
}

/** Wait for you to finish signing in, up to `timeoutMs`. */
export async function waitForLogin(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await status();
    if (!s.open) return s;
    if (s.loggedIn) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return status();
}

const DEGREE = /\b(1st|2nd|3rd|3rd\+)\b/i;

/**
 * "Ken Elefant, mike d. kail & 77 other mutual connections" -> 79.
 * LinkedIn names a couple and counts the rest, and only lists a page of them,
 * so this is what to compare the number actually read against.
 */
function claimedMutuals(text) {
  if (!text) return null;
  const n = /(\d[\d,]*)\s+other\s+mutual/i.exec(text);
  if (n) {
    const named = (text.slice(0, n.index).match(/,|\band\b|&/g) || []).length + (n.index > 0 ? 1 : 0);
    return Number(n[1].replace(/,/g, '')) + Math.max(0, named - 1);
  }
  const plain = /(\d[\d,]*)\s+mutual/i.exec(text);
  return plain ? Number(plain[1].replace(/,/g, '')) : null;
}
const readDegree = (text) => {
  const m = DEGREE.exec(text || '');
  return m ? m[1].toLowerCase().replace('3rd+', '3rd') : null;
};

/**
 * Keep the page for later when something looks wrong — a screenshot shows what
 * happened, the HTML shows why.
 */
async function dumpHtml(tag) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = `${Date.now().toString(36)}-${tag}.html`;
    fs.writeFileSync(path.join(SHOTS_DIR, file), await page.content());
    return file;
  } catch {
    return null;
  }
}

/**
 * Search people and read the result cards.
 *
 * Extraction is structural — every profile link is a person, the block around
 * it is their card — rather than keyed on LinkedIn's class names, which get
 * renamed. The old selector path runs only if that somehow finds nothing.
 */
async function searchPeople(name, company) {
  const q = [name, company].filter(Boolean).join(' ');
  await visit(`${BASE}/search/results/people/?keywords=${encodeURIComponent(q)}`);

  let people = [];
  try {
    people = await page.evaluate(extractPeopleInPage);
  } catch {
    people = [];
  }

  if (!people.length) people = await searchPeopleBySelector();

  return people.slice(0, 10).map((p) => ({
    ...p,
    url: profileUrl(p.url),
    mutual: p.mutual ? { text: p.mutual.text, url: absolute(p.mutual.url) } : null,
  }));
}

/** The original class-name path, kept as a safety net. */
async function searchPeopleBySelector() {
  const cards = await findAll(page, SELECTORS.resultCard);
  const out = [];
  for (const card of cards.slice(0, 10)) {
    const link = await findOne(card, SELECTORS.resultLink);
    if (!link) continue;
    const href = await link.getAttribute('href');
    if (!href || !href.includes('/in/')) continue;

    const whole = ((await card.textContent()) || '').replace(/\s+/g, ' ').trim();
    out.push({
      mutual: await readMutualLink(card),
      name: (await textOf(card, SELECTORS.resultName)) || (await link.textContent())?.trim() || '',
      headline: await textOf(card, SELECTORS.resultHeadline),
      company: await textOf(card, SELECTORS.resultSubline),
      degree: readDegree(await textOf(card, SELECTORS.resultDegree)) || readDegree(whole),
      url: href,
      cardText: whole.slice(0, 400),
    });
  }
  return out;
}

/**
 * The "…and 10 other mutual connections" link on a result card, if it has one.
 * Its presence is itself a signal: LinkedIn only shows it when you share
 * connections with that person.
 */
async function readMutualLink(card) {
  for (const a of await card.$$('a')) {
    const text = ((await a.textContent()) || '').replace(/\s+/g, ' ').trim();
    if (!SELECTORS.mutualText.test(text)) continue;
    return { text, url: absolute(await a.getAttribute('href')) };
  }
  return null;
}

/**
 * Follow a card's mutual-connections link and collect who is on the other
 * side. Navigates when the link has an href, and clicks it on the search page
 * when it does not (LinkedIn sometimes opens these as an overlay).
 */
async function openMutuals(mutual, onPage) {
  if (mutual.url) {
    await visit(mutual.url);
    const landed = page.url();
    const { via, pages } = await collectAllMutuals(landed, onPage);
    return { opened: true, url: landed, via, pages };
  }

  // No href: click the link where it sits. It may navigate, or open a modal.
  const before = page.url();
  let clicked = false;
  for (const card of await findAll(page, SELECTORS.resultCard)) {
    for (const a of await card.$$('a')) {
      const text = ((await a.textContent()) || '').replace(/\s+/g, ' ').trim();
      if (text !== mutual.text) continue;
      await a.click().catch(() => {});
      clicked = true;
      break;
    }
    if (clicked) break;
  }
  if (!clicked) return { opened: false, via: [] };

  await page.waitForURL((u) => u.toString() !== before, { timeout: 8000 }).catch(() => {});
  await wait(PACE.settle);

  if (page.url() !== before) {
    const landed = page.url();
    const { via, pages } = await collectAllMutuals(landed, onPage);
    return { opened: true, url: landed, via, pages };
  }

  // Still on the search page. Only a modal counts — reading the page itself
  // would hand back the search results dressed up as mutual connections.
  const overlay = await findOne(page, SELECTORS.overlay);
  if (overlay) return { opened: true, url: page.url(), via: await collectPeopleCards(overlay) };
  return { opened: false, via: [] };
}

/**
 * Walk every page of a mutual-connections list, not just the first.
 *
 * Paging goes through the URL rather than by clicking "Next": the button is
 * lazily rendered and moves around, while `page=N` on a people search is
 * stable. Stops when a page adds nobody new, and paces itself deliberately —
 * this is the part most likely to look like scraping if hurried.
 */
async function collectAllMutuals(startUrl, onPage) {
  const seen = new Map();
  let pageNo = 1;

  for (; pageNo <= MUTUAL_PAGE_LIMIT; pageNo++) {
    let waited = 0;
    if (pageNo > 1) {
      const url = new URL(startUrl);
      url.searchParams.set('page', String(pageNo));
      waited = await visit(url.toString());
    }

    const batch = await collectPeopleCards();
    let added = 0;
    for (const p of batch) {
      if (p.url && !seen.has(p.url)) {
        seen.set(p.url, p);
        added++;
      }
    }

    await onPage?.({
      page: pageNo,
      added,
      total: seen.size,
      people: [...seen.values()],
      waitedMs: Math.round(waited),
    });

    // A page that adds nobody means the list has run out, or LinkedIn is
    // repeating itself; either way there is nothing further to read.
    if (!added) break;
  }

  return { via: [...seen.values()], pages: Math.min(pageNo, MUTUAL_PAGE_LIMIT) };
}

/**
 * Every person listed on the page. Uses the same structural extraction as the
 * search results — a mutual-connections list is a people list.
 */
async function collectPeopleCards(scope = page) {
  let people = [];
  try {
    people = await page.evaluate(extractPeopleInPage);
  } catch {
    people = [];
  }

  if (!people.length) {
    // Fallback: the old class-name path, scoped to an overlay if given one.
    const cards = await findAll(scope, SELECTORS.sharedCard);
    for (const card of cards.slice(0, 25)) {
      const a = await findOne(card, SELECTORS.resultLink);
      if (!a) continue;
      const href = await a.getAttribute('href');
      const nm = (await textOf(card, SELECTORS.resultName)) || ((await a.textContent()) || '').trim();
      if (nm && href?.includes('/in/')) people.push({ name: nm, url: href });
    }
  }

  return people.slice(0, 25).map((p) => ({
    name: p.name,
    url: profileUrl(p.url),
    headline: p.headline || '',
    company: p.company || '',
    photo: p.photo || null,
  }));
}

/** Open a profile and read back what it says about itself. */
async function readProfile(url) {
  await visit(url);

  let read = null;
  try {
    read = await page.evaluate(extractProfileInPage);
  } catch {
    read = null;
  }

  // Fall back to the class-name selectors if the top card could not be read.
  //
  // Note what is *not* here: a scan of the page's raw text for a degree. A
  // profile carries other people's degrees, and this page even holds an
  // unrendered "· 1st" ahead of the real "· 2nd" — textContent sees hidden
  // nodes, so that scan read a second-degree contact as first-degree.
  if (!read?.name) {
    read = {
      name: await textOf(page, SELECTORS.profileName),
      headline: await textOf(page, SELECTORS.profileHeadline),
      company: await textOf(page, SELECTORS.profileCompany),
      degree: readDegree(await textOf(page, SELECTORS.profileDegree)),
      mutual: null,
    };
  }

  return { ...read, url: page.url().split('?')[0] };
}

/** For a 2nd-degree contact, who do we know in common? */
/** Fallback: the shared-connections link as it appears on a profile page. */
async function readSharedConnections() {
  const link = await findOne(page, SELECTORS.sharedLink);
  if (!link) return [];
  await wait(PACE.betweenActions);
  await link.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(PACE.settle);
  return collectPeopleCards();
}

/**
 * Find one person. Returns what was found and how sure we are; the caller
 * decides what to store. Never guesses past the confidence threshold.
 */
export async function findPerson({ name, company, url, threshold = 0.9, onEvent = () => {} }) {
  if (!ctx || !page) throw new Error('The LinkedIn session is not open.');
  const s = await status();
  if (!s.loggedIn) throw new Error('Not signed in to LinkedIn in the agent window.');

  // Given the profile itself, there is nothing to search for or be unsure
  // about — go straight there.
  if (url) return openKnownProfile({ url, name, company, onEvent });

  onEvent({ type: 'search', query: { name, company } });
  const candidates = await searchPeople(name, company);

  if (!candidates.length) {
    const empty = await capture('Search results');
    if (empty) onEvent({ type: 'shot', ...empty });
    // Nothing read from a page that may well have shown results: keep the
    // markup so the extractor can be corrected against the real thing.
    const html = await dumpHtml('empty-search');
    onEvent({ type: 'results', count: 0, top: [], html });
    return {
      found: false,
      reason:
        'Read no people from the results page. If the screenshot shows results, the page markup ' +
        'has changed — the saved HTML alongside it says how.',
      candidates: [],
      shots: empty ? [empty] : [],
      html,
    };
  }

  const { best, accepted, runnerUp, all } = pickBest({ name, company }, candidates, threshold);
  // What the search actually turned up, scored — the raw material behind the
  // decision, worth showing whether or not anything was accepted.
  const top = all.slice(0, 3).map((c) => ({
    name: c.name,
    headline: c.headline,
    company: c.company,
    degree: c.degree,
    url: c.url,
    mutual: c.mutual?.text || null,
    confidence: c.confidence,
    nameScore: c.nameScore,
    companyScore: c.companyScore,
  }));
  const shots = [];
  const shot = async (label) => {
    const s = await capture(label);
    if (s) {
      shots.push(s);
      onEvent({ type: 'shot', ...s });
    }
    return s;
  };

  await shot('Search results');
  onEvent({ type: 'results', count: candidates.length, top, threshold });

  if (!accepted) {
    const reason =
      `Best match was ${best.name} at ${Math.round(best.confidence * 100)}% confidence, ` +
      `below the ${Math.round(threshold * 100)}% bar.`;
    // A near miss often has a mutual-connections link too. Not following it is
    // the point of the bar: those are someone else's connections.
    onEvent({
      type: 'rejected',
      reason,
      hadMutualLink: !!best.mutual,
    });
    return { found: false, reason, candidates: top, shots };
  }

  onEvent({
    type: 'accepted',
    name: best.name,
    confidence: best.confidence,
    rank: all.indexOf(best) + 1,
    threshold,
  });

  // Past the bar, so the mutual-connections link on that card is worth
  // opening — and it is right here, on the page already in front of us.
  let via = [];
  let mutualPage = null;
  if (best.mutual) {
    onEvent({ type: 'mutual-found', text: best.mutual.text, url: best.mutual.url });
    await wait(PACE.betweenActions);
    const opened = await openMutuals(best.mutual, (p) =>
      onEvent({ type: 'shared-page', ...p, from: 'search result' })
    );
    via = opened.via;
    if (opened.opened) {
      // Only worth capturing once we are actually on that page.
      const cap = await shot('Mutual connections');
      mutualPage = {
        link: best.mutual.url,
        text: best.mutual.text,
        pageUrl: opened.url,
        html: cap?.html || null,
        claimed: claimedMutuals(best.mutual.text),
        pages: opened.pages || 1,
      };
      onEvent({ type: 'shared', count: via.length, via, from: 'search result', ...mutualPage });
    } else {
      onEvent({ type: 'mutual-dead', text: best.mutual.text });
    }
  } else {
    onEvent({ type: 'no-mutual-link' });
  }

  await wait(PACE.betweenActions);
  onEvent({ type: 'opening', url: best.url, name: best.name });
  const profile = await readProfile(best.url);
  await shot('Profile');
  const degree = profile.degree || best.degree || null;
  onEvent({ type: 'profile', profile: { ...profile, degree } });

  // No link on the card but the profile has one (or says 2nd degree): try the
  // profile's own shared-connections route instead.
  if (!via.length && (profile.mutual || degree === '2nd')) {
    onEvent({ type: 'shared-start' });
    let landed = null;
    if (profile.mutual) {
      landed = await openMutuals(profile.mutual, (p) =>
        onEvent({ type: 'shared-page', ...p, from: 'profile' })
      );
      via = landed.via;
    } else {
      via = await readSharedConnections();
    }
    const cap = await shot('Mutual connections');
    mutualPage = {
      link: profile.mutual?.url || null,
      text: profile.mutual?.text || null,
      pageUrl: landed?.url || page.url(),
      html: cap?.html || null,
      claimed: claimedMutuals(profile.mutual?.text),
      pages: landed?.pages || 1,
    };
    onEvent({ type: 'shared', count: via.length, via, from: 'profile', ...mutualPage });
  }

  return {
    found: true,
    confidence: best.confidence,
    candidates: top,
    shots,
    runnerUp: runnerUp ? { name: runnerUp.name, confidence: runnerUp.confidence } : null,
    person: {
      name: profile.name || best.name,
      company: profile.company || best.company || company,
      headline: profile.headline || best.headline,
      url: profile.url || best.url,
      degree,
      via,
      mutualText: best.mutual?.text || mutualPage?.text || null,
      // Where the connections were read from, and the saved copy of it.
      mutualPage,
    },
  };
}

/**
 * Look someone up by their profile address rather than by name. Used for the
 * people already in your network, where the profile is known: no search, no
 * confidence to weigh, and no chance of landing on a namesake.
 */
async function openKnownProfile({ url, name, company, onEvent }) {
  const shots = [];
  const shot = async (label) => {
    const cap = await capture(label);
    if (cap) {
      shots.push(cap);
      onEvent({ type: 'shot', ...cap });
    }
    return cap;
  };

  onEvent({ type: 'direct', url, name });
  const profile = await readProfile(url);
  await shot('Profile');
  const degree = profile.degree || null;
  onEvent({ type: 'profile', profile: { ...profile, degree } });

  let via = [];
  let mutualPage = null;
  if (profile.mutual) {
    onEvent({ type: 'mutual-found', text: profile.mutual.text, url: profile.mutual.url });
    const landed = await openMutuals(profile.mutual, (p) => onEvent({ type: 'shared-page', ...p, from: 'profile' }));
    via = landed.via;
    if (landed.opened) {
      const cap = await shot('Mutual connections');
      mutualPage = {
        link: profile.mutual.url,
        text: profile.mutual.text,
        pageUrl: landed.url,
        html: cap?.html || null,
        claimed: claimedMutuals(profile.mutual.text),
        pages: landed.pages || 1,
      };
      onEvent({ type: 'shared', count: via.length, via, from: 'profile', ...mutualPage });
    }
  }

  return {
    found: true,
    confidence: 1, // the profile was named, not guessed at
    candidates: [],
    shots,
    person: {
      name: profile.name || name,
      company: profile.company || company || '',
      headline: profile.headline,
      url: profile.url || url,
      degree,
      via,
      mutualText: profile.mutual?.text || null,
      mutualPage,
    },
  };
}

export const pauseBetweenLookups = () => wait(PACE.betweenLookups);
