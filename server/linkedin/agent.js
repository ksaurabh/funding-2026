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
import { pickBest } from './match.js';

const PROFILE_DIR = path.join(DATA_DIR, 'linkedin-profile');
export const SHOTS_DIR = path.join(DATA_DIR, 'linkedin-shots');
// Overridable only so the pipeline can be exercised against a stand-in page.
const BASE = process.env.LINKEDIN_BASE || 'https://www.linkedin.com';

// Pacing, in milliseconds. Deliberately unhurried.
const PACE = { betweenActions: [1200, 2600], afterNavigation: [1500, 3000], betweenLookups: [4000, 9000] };

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
    const file = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage: false });
    return { label, file, url: page.url() };
  } catch {
    return null; // a screenshot is a nicety; never fail a lookup over one
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
  await page.goto(`${BASE}/feed/`, { waitUntil: 'domcontentloaded' });
  await wait(PACE.afterNavigation);
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
    await page.goto(`${BASE}/feed/`, { waitUntil: 'domcontentloaded' });
    await wait(PACE.afterNavigation);
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
const readDegree = (text) => {
  const m = DEGREE.exec(text || '');
  return m ? m[1].toLowerCase().replace('3rd+', '3rd') : null;
};

/** Search people, returning the raw candidate cards. */
async function searchPeople(name, company) {
  const q = [name, company].filter(Boolean).join(' ');
  await page.goto(`${BASE}/search/results/people/?keywords=${encodeURIComponent(q)}`, {
    waitUntil: 'domcontentloaded',
  });
  await wait(PACE.afterNavigation);

  const cards = await findAll(page, SELECTORS.resultCard);
  const out = [];
  for (const card of cards.slice(0, 10)) {
    const link = await findOne(card, SELECTORS.resultLink);
    if (!link) continue;
    const href = await link.getAttribute('href');
    if (!href || !href.includes('/in/')) continue;
    const url = profileUrl(href);
    if (!url) continue;

    const whole = ((await card.textContent()) || '').replace(/\s+/g, ' ').trim();
    out.push({
      mutual: await readMutualLink(card),
      name: (await textOf(card, SELECTORS.resultName)) || (await link.textContent())?.trim() || '',
      headline: await textOf(card, SELECTORS.resultHeadline),
      company: await textOf(card, SELECTORS.resultSubline),
      degree: readDegree(await textOf(card, SELECTORS.resultDegree)) || readDegree(whole),
      url,
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
async function openMutuals(mutual) {
  if (mutual.url) {
    await page.goto(mutual.url, { waitUntil: 'domcontentloaded' });
    await wait(PACE.afterNavigation);
    return collectPeopleCards();
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
  if (!clicked) return [];

  await page.waitForURL((u) => u.toString() !== before, { timeout: 8000 }).catch(() => {});
  await wait(PACE.afterNavigation);

  if (page.url() !== before) return collectPeopleCards();

  // Still on the search page. Only a modal counts — reading the page itself
  // would hand back the search results dressed up as mutual connections.
  const overlay = await findOne(page, SELECTORS.overlay);
  return overlay ? collectPeopleCards(overlay) : [];
}

/** Every person listed in the given scope (the page, or an overlay in it). */
async function collectPeopleCards(scope = page) {
  const cards = await findAll(scope, SELECTORS.sharedCard);
  const via = [];
  for (const card of cards.slice(0, 25)) {
    const a = await findOne(card, SELECTORS.resultLink);
    if (!a) continue;
    const href = await a.getAttribute('href');
    const nm = (await textOf(card, SELECTORS.resultName)) || ((await a.textContent()) || '').trim();
    if (nm && href?.includes('/in/')) via.push({ name: nm, url: profileUrl(href) });
  }
  return via;
}

/** Open a profile and read back what it says about itself. */
async function readProfile(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await wait(PACE.afterNavigation);
  const body = ((await page.textContent('body')) || '').slice(0, 4000);
  return {
    url: page.url().split('?')[0],
    name: await textOf(page, SELECTORS.profileName),
    headline: await textOf(page, SELECTORS.profileHeadline),
    company: await textOf(page, SELECTORS.profileCompany),
    degree: readDegree(await textOf(page, SELECTORS.profileDegree)) || readDegree(body),
  };
}

/** For a 2nd-degree contact, who do we know in common? */
/** Fallback: the shared-connections link as it appears on a profile page. */
async function readSharedConnections() {
  const link = await findOne(page, SELECTORS.sharedLink);
  if (!link) return [];
  await wait(PACE.betweenActions);
  await link.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(PACE.afterNavigation);
  return collectPeopleCards();
}

/**
 * Find one person. Returns what was found and how sure we are; the caller
 * decides what to store. Never guesses past the confidence threshold.
 */
export async function findPerson({ name, company, threshold = 0.9, onEvent = () => {} }) {
  if (!ctx || !page) throw new Error('The LinkedIn session is not open.');
  const s = await status();
  if (!s.loggedIn) throw new Error('Not signed in to LinkedIn in the agent window.');

  onEvent({ type: 'search', query: { name, company } });
  const candidates = await searchPeople(name, company);

  if (!candidates.length) {
    const empty = await capture('Search results');
    if (empty) onEvent({ type: 'shot', ...empty });
    onEvent({ type: 'results', count: 0, top: [] });
    return {
      found: false,
      reason: 'LinkedIn returned no people for that search.',
      candidates: [],
      shots: empty ? [empty] : [],
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
  };

  await shot('Search results');
  onEvent({ type: 'results', count: candidates.length, top, threshold });

  if (!accepted) {
    const reason =
      `Best match was ${best.name} at ${Math.round(best.confidence * 100)}% confidence, ` +
      `below the ${Math.round(threshold * 100)}% bar.`;
    onEvent({ type: 'rejected', reason });
    return { found: false, reason, candidates: top, shots };
  }

  // The mutual-connections link lives on the search card, so follow it while
  // that page is still in front of us.
  let via = [];
  if (best.mutual) {
    onEvent({ type: 'mutual-found', text: best.mutual.text, url: best.mutual.url });
    await wait(PACE.betweenActions);
    via = await openMutuals(best.mutual, { name, company });
    await shot('Mutual connections');
    onEvent({ type: 'shared', count: via.length, via, from: 'search result' });
  }

  await wait(PACE.betweenActions);
  onEvent({ type: 'opening', url: best.url, name: best.name });
  const profile = await readProfile(best.url);
  await shot('Profile');
  const degree = profile.degree || best.degree || null;
  onEvent({ type: 'profile', profile: { ...profile, degree } });

  // No link on the card but the profile says 2nd degree: try the profile's own
  // shared-connections route instead.
  if (!via.length && degree === '2nd') {
    onEvent({ type: 'shared-start' });
    via = await readSharedConnections();
    await shot('Mutual connections');
    onEvent({ type: 'shared', count: via.length, via, from: 'profile' });
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
      mutualText: best.mutual?.text || null,
    },
  };
}

export const pauseBetweenLookups = () => wait(PACE.betweenLookups);
