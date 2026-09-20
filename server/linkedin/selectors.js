// Every LinkedIn-specific selector lives here.
//
// LinkedIn changes its markup often and without notice; when a lookup starts
// coming back empty or mislabelled, this file is the only place to fix. Each
// entry is a list tried in order, so an old and a new selector can coexist.

export const SELECTORS = {
  // Signed-in state
  loggedIn: ['#global-nav', 'nav.global-nav', '[data-test-global-nav]'],
  loginForm: ['#username', 'form.login__form', '[data-test-id="sign-in-form"]'],

  // People search results
  resultCard: [
    'div[data-chameleon-result-urn]',
    'ul.reusable-search__entity-result-list > li',
    'li.reusable-search__result-container',
    '.search-results-container li',
  ],
  resultLink: ['a[href*="/in/"]'],
  resultName: ['span[aria-hidden="true"]', '.entity-result__title-text a span', 'span.t-16'],
  resultHeadline: ['.entity-result__primary-subtitle', '.t-14.t-black.t-normal', 'div.t-14'],
  resultSubline: ['.entity-result__secondary-subtitle', '.t-14.t-normal.t-black--light'],
  resultDegree: ['.entity-result__badge-text', 'span.dist-value', '.entity-result__badge'],

  // Profile page
  profileName: ['h1', '.text-heading-xlarge'],
  profileHeadline: ['.text-body-medium.break-words', 'div.text-body-medium'],
  profileDegree: ['span.dist-value', '.distance-badge .dist-value', '.pv-top-card__distance-badge'],
  profileCompany: [
    'button[aria-label^="Current company"] span',
    '.pv-text-details__right-panel button span',
    'ul.pv-top-card--experience-list li',
  ],

  // Shared ("mutual") connections
  sharedLink: ['a[href*="facetConnectionOf"]', 'a[href*="/search/results/people/?facetNetwork"]'],
  sharedCard: [
    'div[data-chameleon-result-urn]',
    'ul.reusable-search__entity-result-list > li',
    'li.reusable-search__result-container',
  ],
};

/** First selector in the list that matches, or null. */
export async function findOne(scope, names) {
  for (const sel of names) {
    const el = await scope.$(sel);
    if (el) return el;
  }
  return null;
}

export async function findAll(scope, names) {
  for (const sel of names) {
    const els = await scope.$$(sel);
    if (els.length) return els;
  }
  return [];
}

export async function textOf(scope, names) {
  const el = await findOne(scope, names);
  if (!el) return '';
  return ((await el.textContent()) || '').replace(/\s+/g, ' ').trim();
}
