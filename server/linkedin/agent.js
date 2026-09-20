// The LinkedIn agent: one real Chrome window, driven slowly, using your own
// logged-in session.
//
// Nothing here logs you in — you do that yourself in the window it opens, and
// the session is kept in a profile directory so you only do it once. Actions
// are paced deliberately: this is a research assistant working at human speed,
// not a scraper.
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA_DIR } from '../store.js';
import { SELECTORS, findOne, findAll, textOf } from './selectors.js';
import { pickBest } from './match.js';

const PROFILE_DIR = path.join(DATA_DIR, 'linkedin-profile');
// Overridable only so the pipeline can be exercised against a stand-in page.
const BASE = process.env.LINKEDIN_BASE || 'https://www.linkedin.com';

// Pacing, in milliseconds. Deliberately unhurried.
const PACE = { betweenActions: [1200, 2600], afterNavigation: [1500, 3000], betweenLookups: [4000, 9000] };

/** Result hrefs come back relative as often as absolute. */
const absolute = (href) => {
  try {
    return new URL(href, BASE).toString().split('?')[0];
  } catch {
    return null;
  }
};

const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo);
const wait = (range) => new Promise((r) => setTimeout(r, jitter(range)));

let ctx = null; // the persistent browser context
let page = null;

export const isOpen = () => !!ctx;

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
    const url = absolute(href);
    if (!url) continue;

    const whole = ((await card.textContent()) || '').replace(/\s+/g, ' ').trim();
    out.push({
      name: (await textOf(card, SELECTORS.resultName)) || (await link.textContent())?.trim() || '',
      headline: await textOf(card, SELECTORS.resultHeadline),
      company: await textOf(card, SELECTORS.resultSubline),
      degree: readDegree(await textOf(card, SELECTORS.resultDegree)) || readDegree(whole),
      url,
    });
  }
  return out;
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
async function readSharedConnections() {
  const link = await findOne(page, SELECTORS.sharedLink);
  if (!link) return [];
  await wait(PACE.betweenActions);
  await link.click().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await wait(PACE.afterNavigation);

  const cards = await findAll(page, SELECTORS.sharedCard);
  const via = [];
  for (const card of cards.slice(0, 25)) {
    const a = await findOne(card, SELECTORS.resultLink);
    if (!a) continue;
    const href = await a.getAttribute('href');
    const nm = (await textOf(card, SELECTORS.resultName)) || ((await a.textContent()) || '').trim();
    if (nm && href?.includes('/in/')) via.push({ name: nm, url: absolute(href) });
  }
  return via;
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
    onEvent({ type: 'results', count: 0, top: [] });
    return { found: false, reason: 'LinkedIn returned no people for that search.', candidates: [] };
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
    confidence: c.confidence,
    nameScore: c.nameScore,
    companyScore: c.companyScore,
  }));
  onEvent({ type: 'results', count: candidates.length, top, threshold });

  if (!accepted) {
    const reason =
      `Best match was ${best.name} at ${Math.round(best.confidence * 100)}% confidence, ` +
      `below the ${Math.round(threshold * 100)}% bar.`;
    onEvent({ type: 'rejected', reason });
    return { found: false, reason, candidates: top };
  }

  await wait(PACE.betweenActions);
  onEvent({ type: 'opening', url: best.url, name: best.name });
  const profile = await readProfile(best.url);
  const degree = profile.degree || best.degree || null;
  onEvent({ type: 'profile', profile: { ...profile, degree } });

  let via = [];
  if (degree === '2nd') {
    onEvent({ type: 'shared-start' });
    via = await readSharedConnections();
    onEvent({ type: 'shared', count: via.length, via });
  }

  return {
    found: true,
    confidence: best.confidence,
    candidates: top,
    runnerUp: runnerUp ? { name: runnerUp.name, confidence: runnerUp.confidence } : null,
    person: {
      name: profile.name || best.name,
      company: profile.company || best.company || company,
      headline: profile.headline || best.headline,
      url: profile.url || best.url,
      degree,
      via,
    },
  };
}

export const pauseBetweenLookups = () => wait(PACE.betweenLookups);
