// Pulling people out of a LinkedIn results page without relying on its class
// names.
//
// Written against real captured pages. Two things there are load-bearing and
// neither is a class name:
//   - a person's card always carries a degree marker ("Name • 2nd")
//   - the "…& 77 other mutual connections" sentence is a nested block whose
//     preview names are links to *other* people; they are not results
//
// Runs inside the page via page.evaluate, so it must be self-contained.
export function extractPeopleInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const DEGREE = /•\s*(1st|2nd|3rd\+?)\b/i;
  const DEGREE_LOOSE = /(?:^|[^\w])(1st|2nd|3rd\+?)(?:[^\w]|$)/i;
  const MUTUAL = /mutual connections?$/i;

  const root = document.querySelector('main') || document.body;
  const isChrome = (el) => !!el.closest('nav, header, .global-nav');

  // Anything that could be a card. LinkedIn has used li, data-chameleon and
  // componentkey divs at different times; ask for all of them.
  const boxes = [...root.querySelectorAll('div[componentkey], li, [data-chameleon-result-urn], [data-view-name]')];

  // A card is a box that names a person and states how far away they are.
  let cards = boxes.filter(
    (b) => !isChrome(b) && b.querySelector('a[href*="/in/"]') && DEGREE.test(clean(b.innerText))
  );
  // Keep the innermost: outer wrappers repeat their children's text.
  cards = cards.filter((b) => !cards.some((o) => o !== b && b.contains(o)));

  // A person's avatar, when the card has one worth showing.
  const photoIn = (scope, exclude) => {
    for (const img of scope.querySelectorAll('img')) {
      if (exclude && exclude.contains(img)) continue;
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:')) continue;
      if (/ghost|placeholder|spacer/i.test(src)) continue;
      return src;
    }
    return null;
  };

  const people = [];
  const seen = new Set();

  for (const card of cards) {
    const text = clean(card.innerText);

    // The mutual-connections sentence, and the preview people inside it, are
    // not this card's subject — set them aside before picking the name.
    const mutualBlock = [...card.querySelectorAll('*')].find(
      (n) => MUTUAL.test(clean(n.innerText)) && !n.querySelector('a[href*="/search/"]')
    );
    const mutualLink = [...card.querySelectorAll('a')].find((a) => MUTUAL.test(clean(a.innerText)));

    const primary = [...card.querySelectorAll('a[href*="/in/"]')].find(
      (a) => clean(a.innerText) && !(mutualBlock && mutualBlock.contains(a)) && !MUTUAL.test(clean(a.innerText))
    );
    if (!primary) continue;

    const url = (primary.href || '').split('?')[0];
    if (!/\/in\/[^/?#]+/.test(url) || seen.has(url)) continue;

    // "Greg Dracon • 2nd" — the name is what precedes the bullet.
    const lines = (card.innerText || '').split('\n').map(clean).filter(Boolean);
    const headLine = lines.find((l) => DEGREE.test(l)) || '';
    const name = clean(headLine.split('•')[0]) || clean(primary.innerText).split('\n')[0];
    if (!name) continue;

    // What follows the name line, skipping the mutual sentence and actions.
    const at = lines.indexOf(headLine);
    const rest = (at >= 0 ? lines.slice(at + 1) : lines).filter(
      (l) => !MUTUAL.test(l) && !/^(Message|Connect|Follow|View .*profile)$/i.test(l)
    );

    const degree = (DEGREE.exec(text) || DEGREE_LOOSE.exec(text) || [])[1];

    people.push({
      name,
      photo: photoIn(card, mutualBlock),
      headline: rest[0] || '',
      company: rest[1] || '',
      degree: degree ? degree.toLowerCase().replace('3rd+', '3rd') : null,
      url,
      cardText: text.slice(0, 400),
      mutual: mutualLink ? { text: clean(mutualLink.innerText), url: mutualLink.getAttribute('href') || null } : null,
    });
    seen.add(url);
  }

  if (people.length) return people;

  // Nothing matched the card shape — fall back to treating each profile link
  // as a person, which is wrong more often but better than reporting nothing.
  for (const a of root.querySelectorAll('a[href*="/in/"]')) {
    if (isChrome(a)) continue;
    const url = (a.href || '').split('?')[0];
    const name = clean(a.innerText).split('\n')[0];
    if (!name || !/\/in\/[^/?#]+/.test(url) || seen.has(url) || MUTUAL.test(name)) continue;
    const box = a.closest('div, li') || a.parentElement;
    people.push({
      name,
      photo: box ? photoIn(box) : null,
      headline: '',
      company: '',
      degree: (DEGREE_LOOSE.exec(clean(box?.innerText)) || [])[1] || null,
      url,
      cardText: clean(box?.innerText).slice(0, 400),
      mutual: null,
    });
    seen.add(url);
  }
  return people;
}

/**
 * Read a profile's top card. Also structural: real profiles captured from
 * LinkedIn have no <h1> at all, and the degree sits on its own line as
 * "· 2nd" under the name.
 *
 * Runs inside the page via page.evaluate.
 */
export function extractProfileInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const DEGREE_LINE = /^[·•]?\s*(1st|2nd|3rd\+?)\s*$/i;
  const MUTUAL = /mutual connections?$/i;
  const SKIP = /^(Contact info|·|Connect|Follow|Message|More|Save in Sales Navigator)$/i;

  const main = document.querySelector('main') || document.body;
  const lines = (main.innerText || '').split('\n').map(clean).filter(Boolean);

  const name = lines[0] || '';

  // The degree belongs to the top card, so it sits directly under the name.
  // Anything further down is someone else — a profile page carries a dozen
  // other people's degrees in "people also viewed" and similar.
  const degreeAt = lines.findIndex((l, i) => i <= 3 && DEGREE_LINE.test(l));
  const degree = degreeAt >= 0 ? DEGREE_LINE.exec(lines[degreeAt])[1].toLowerCase().replace('3rd+', '3rd') : null;

  // The headline is the first real line after the name/degree.
  const after = lines.slice(Math.max(1, degreeAt + 1));
  const headline = after.find((l) => !SKIP.test(l) && !MUTUAL.test(l)) || '';

  // LinkedIn lists the current company just after the contact-info row.
  const contactAt = lines.findIndex((l) => /^Contact info$/i.test(l));
  const company = contactAt >= 0 ? lines.slice(contactAt + 1).find((l) => !SKIP.test(l)) || '' : '';

  const mutualEl = [...main.querySelectorAll('a')].find((a) => MUTUAL.test(clean(a.innerText)));

  return {
    name,
    headline,
    company,
    degree,
    mutual: mutualEl ? { text: clean(mutualEl.innerText), url: mutualEl.getAttribute('href') || null } : null,
  };
}

/**
 * Read the parts of a profile that say what someone actually does: the About
 * paragraph and the Experience entries, including the date ranges that make a
 * board seat or an observer role legible ("Board Observer · Jan 2021 – Present").
 *
 * Structural, like the rest of this file: LinkedIn's section markup is found
 * by its heading text, its entries by the presence of a date range, never by
 * class name. The raw section text is returned alongside the parsed entries,
 * because the parse is the part most likely to go stale and a caller passing
 * this to a model would rather have both.
 *
 * Runs inside the page via page.evaluate, so it must be self-contained.
 */
export function extractProfileDetailInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lines = (s) => (s || '').split('\n').map(clean).filter(Boolean);

  const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
  // "Jan 2021 - Present", "2019 – 2022", "Mar 2020 - Dec 2021 · 1 yr 10 mos"
  const RANGE = new RegExp(
    `(?:${MONTH}\\s+)?(?:19|20)\\d{2}\\s*[-–—]\\s*(?:Present|(?:${MONTH}\\s+)?(?:19|20)\\d{2})`,
    'i'
  );
  const DURATION = /·\s*(?:\d+\s*yrs?)?\s*(?:\d+\s*mos?)?/i;
  const NOISE = /^(?:Show all|See more|see less|…see more|Endorse|Message|Connect|Follow|Skills?:)/i;

  const main = document.querySelector('main') || document.body;

  // A section is the block whose own heading is the one we want. Headings
  // repeat inside "people also viewed", so only take blocks under main.
  const sectionFor = (title) => {
    const heads = [...main.querySelectorAll('h2, h3, [role="heading"]')].filter(
      (h) => clean(h.innerText).toLowerCase() === title
    );
    for (const h of heads) {
      const box = h.closest('section') || h.parentElement?.parentElement;
      if (box && clean(box.innerText)) return box;
    }
    return null;
  };

  // About: everything under the heading except the heading itself.
  const aboutBox = sectionFor('about');
  let summary = '';
  if (aboutBox) {
    const ls = lines(aboutBox.innerText).filter((l) => l.toLowerCase() !== 'about' && !NOISE.test(l));
    // LinkedIn repeats the visible text for screen readers; drop the repeat.
    const half = ls.slice(0, Math.ceil(ls.length / 2)).join(' ');
    const whole = ls.join(' ');
    summary = whole === half + ' ' + half ? half : whole;
  }

  const expBox = sectionFor('experience');
  const positions = [];
  if (expBox) {
    // Each entry is the innermost list item that carries a date range.
    let items = [...expBox.querySelectorAll('li, div[data-view-name], div[componentkey]')].filter((n) =>
      RANGE.test(clean(n.innerText))
    );
    items = items.filter((n) => !items.some((o) => o !== n && n.contains(o)));

    for (const item of items) {
      const ls = lines(item.innerText).filter((l) => !NOISE.test(l));
      // LinkedIn duplicates each line for assistive tech; keep first sightings.
      const seen = new Set();
      const uniq = ls.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));

      const at = uniq.findIndex((l) => RANGE.test(l));
      if (at < 0) continue;
      const dates = uniq[at];
      const head = uniq.slice(0, at);
      const tail = uniq.slice(at + 1);

      positions.push({
        title: head[0] || '',
        // "Acme Corp · Full-time" — the employment type is not the company.
        company: (head[1] || '').split('·')[0].trim(),
        dates: dates.replace(DURATION, '').trim(),
        duration: (dates.match(DURATION) || [''])[0].replace(/^·\s*/, '').trim(),
        current: /present/i.test(dates),
        // A location line has no sentence punctuation; a description does.
        location: tail[0] && !/[.!?]$/.test(tail[0]) && tail[0].length < 60 ? tail[0] : '',
        description: tail.filter((l) => /[.!?]$/.test(l) || l.length >= 60).join(' '),
      });
    }
  }

  return {
    name: lines(main.innerText)[0] || '',
    summary,
    positions,
    // What the parse was made from, so a caller can see past a stale parse.
    experienceText: expBox ? lines(expBox.innerText).filter((l) => !NOISE.test(l)).join('\n').slice(0, 4000) : '',
  };
}

/**
 * Find the "Connections of" field in the All-filters panel and tag it, so the
 * caller can then click and type into it with real events.
 *
 * The panel is a right-hand drawer that may render outside <main>, may sit in
 * a portal at the end of <body>, lazily fills in as it scrolls, and sometimes
 * shows a button that reveals the typeahead rather than the typeahead itself.
 * So: find the heading by its words, take the block around it, and look for a
 * field in there — never a class name, and never assuming a dialog role.
 *
 * Returns what it found either way; the diagnostics are what make a failure
 * fixable from a saved page instead of guessed at.
 *
 * Runs inside the page via page.evaluate.
 */
export function findConnectionsFieldInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const HEADING = /^connections of\b/i;
  const ADD = /add a connection|connections of/i;

  for (const el of document.querySelectorAll('[data-agent-field]')) el.removeAttribute('data-agent-field');

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // The heading, wherever it lives. Innermost match, so the label rather than
  // the whole panel that contains it.
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,label,legend,span,div,p,button')].filter((n) =>
    HEADING.test(clean(n.innerText))
  );
  const heading = headings.filter((n) => !headings.some((o) => o !== n && n.contains(o))).pop() || null;

  // The panel is whatever scrollable ancestor holds it — useful to report and
  // to scroll when the section has not rendered yet.
  const panelOf = (node) => {
    for (let el = node; el; el = el.parentElement) {
      if (el === document.body) break;
      const style = getComputedStyle(el);
      if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      if (el.getAttribute('role') === 'dialog' || el.classList.contains('artdeco-modal')) return el;
    }
    return null;
  };

  const dialog = document.querySelector('[role="dialog"], .artdeco-modal, aside[aria-label], div[aria-label*="filter" i]');
  const panel = (heading && panelOf(heading)) || dialog || null;

  if (!heading) {
    return {
      found: false,
      why: 'no heading whose text starts with "Connections of"',
      panelText: clean(panel?.innerText || '').slice(0, 1200),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,legend')].map((h) => clean(h.innerText)).filter(Boolean).slice(0, 40),
    };
  }

  // The section: walk up until the block holds more than the heading itself.
  let section = heading;
  for (let i = 0; i < 6 && section.parentElement; i++) {
    section = section.parentElement;
    if (section.querySelector('input, button') && clean(section.innerText).length > clean(heading.innerText).length) break;
  }

  const inputs = [...section.querySelectorAll('input')].filter(
    (n) => visible(n) && !/^(checkbox|radio|hidden|submit)$/i.test(n.type || '')
  );
  if (inputs[0]) {
    inputs[0].setAttribute('data-agent-field', 'input');
    return { found: true, kind: 'input', sectionText: clean(section.innerText).slice(0, 400) };
  }

  // No input yet: a button ("Add a connection") reveals it on some layouts.
  const button = [...section.querySelectorAll('button, [role="button"], a')].find(
    (n) => visible(n) && ADD.test(clean(n.innerText) + ' ' + (n.getAttribute('aria-label') || ''))
  );
  if (button) {
    button.setAttribute('data-agent-field', 'button');
    return { found: true, kind: 'button', sectionText: clean(section.innerText).slice(0, 400) };
  }

  return {
    found: false,
    why: 'found the "Connections of" heading but no field or button under it',
    sectionText: clean(section.innerText).slice(0, 600),
    panelText: clean(panel?.innerText || '').slice(0, 1200),
  };
}

/** Tag the typeahead suggestions, however they are marked up. */
export function findTypeaheadOptionsInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('[data-agent-option]')) el.removeAttribute('data-agent-option');

  let options = [...document.querySelectorAll('[role="option"]')];
  if (!options.length) {
    // A bare list under the field, then: any list whose items are people.
    const lists = [...document.querySelectorAll('ul, [role="listbox"]')].filter((ul) => {
      const items = [...ul.children].filter((li) => clean(li.innerText));
      return items.length > 0 && items.length <= 12 && items.every((li) => clean(li.innerText).length < 120);
    });
    const list = lists[lists.length - 1];
    if (list) options = [...list.children];
  }
  options = options.filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && clean(n.innerText);
  });
  options.forEach((n, i) => n.setAttribute('data-agent-option', String(i)));

  // The name and the rest, kept apart. A suggestion reads "Ashu Garg" then a
  // headline that can run to thirty words; scoring a name against all of that
  // scores nothing, so the first line is returned on its own.
  return options.map((n) => {
    const lines = (n.innerText || '').split('\n').map(clean).filter(Boolean);
    return { name: lines[0] || '', text: clean(n.innerText).slice(0, 300) };
  });
}

/**
 * Find the button that opens the All-filters drawer and tag it.
 *
 * Its accessible name moves around ("All filters", "Show all filters"), it can
 * be an anchor or a div with a button role, and on a freshly loaded results
 * page it appears after the results do — so the caller polls this rather than
 * deciding on the first frame. The list of buttons it did see is returned, so
 * a failure says what was actually on the page.
 *
 * Runs inside the page via page.evaluate.
 */
export function findAllFiltersButtonInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const WANT = /all filters/i;

  for (const el of document.querySelectorAll('[data-agent-allfilters]')) el.removeAttribute('data-agent-allfilters');

  const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  const hit = candidates.find((n) => WANT.test(clean(n.innerText)) || WANT.test(n.getAttribute('aria-label') || ''));
  if (hit) {
    hit.setAttribute('data-agent-allfilters', '1');
    return { found: true, label: clean(hit.innerText) || hit.getAttribute('aria-label') };
  }

  return {
    found: false,
    // What the filter bar did offer, which is the fastest way to see whether
    // the page is still loading or the control has simply been renamed.
    buttons: candidates
      .map((n) => clean(n.innerText) || n.getAttribute('aria-label') || '')
      .filter(Boolean)
      .slice(0, 30),
    results: document.querySelectorAll('a[href*="/in/"]').length,
  };
}

/**
 * Find the control that applies the filters, and report what it would apply.
 *
 * On a real panel this is an anchor, not a button — `<a href="…/search/results/
 * people/?keywords=…&origin=FACETED_SEARCH">Show results</a>` — with its label
 * two spans deep, next to a "Reset" button. Its href is also the honest signal
 * that a filter has taken: the connection facet appears in it as soon as the
 * typeahead selection registers, so the caller can check rather than hope.
 *
 * Runs inside the page via page.evaluate.
 */
export function findShowResultsInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const WANT = /^show(\s+[\d,+]+)?\s+results?$/i;

  for (const el of document.querySelectorAll('[data-agent-apply]')) el.removeAttribute('data-agent-apply');

  const candidates = [...document.querySelectorAll('a, button, [role="button"]')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  const hit =
    candidates.find((n) => WANT.test(clean(n.innerText))) ||
    candidates.find((n) => WANT.test(n.getAttribute('aria-label') || ''));
  if (!hit) {
    return {
      found: false,
      controls: candidates.map((n) => clean(n.innerText) || n.getAttribute('aria-label') || '').filter(Boolean).slice(0, 30),
    };
  }

  hit.setAttribute('data-agent-apply', '1');
  return {
    found: true,
    tag: hit.tagName.toLowerCase(),
    label: clean(hit.innerText),
    href: hit.getAttribute('href') || null,
    disabled: hit.getAttribute('aria-disabled') === 'true' || hit.disabled === true,
  };
}

/**
 * What the "Connections of" section currently has selected.
 *
 * A picked connection is not a chip and does not show up in the apply link's
 * href — that href is static. It is a checked radio with the person's name
 * beside it:
 *
 *   <div role="radio" aria-checked="true"> … <input type="radio" checked> … <p>Ashu Garg</p>
 *
 * so this reads the checked controls in that section and reports their names.
 *
 * Runs inside the page via page.evaluate.
 */
export function readConnectionsSelectionInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const HEADING = /^connections of\b/i;

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,label,legend,span,div,p,button')].filter((n) =>
    HEADING.test(clean(n.innerText))
  );
  const heading = headings.filter((n) => !headings.some((o) => o !== n && n.contains(o))).pop() || null;
  if (!heading) return { found: false, selected: [] };

  // The block that holds the heading and its controls.
  let section = heading;
  for (let i = 0; i < 6 && section.parentElement; i++) {
    section = section.parentElement;
    if (section.querySelector('[role="radio"], [role="checkbox"], input')) break;
  }

  const checked = [
    ...section.querySelectorAll(
      '[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"], input:checked'
    ),
  ];

  // The name sits next to the control, inside the row that holds both.
  const names = checked
    .map((c) => {
      let row = c;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        row = row.parentElement;
        const text = clean(row.innerText);
        if (text) return text.split('\n')[0];
      }
      return '';
    })
    .map(clean)
    .filter(Boolean);

  return { found: true, selected: [...new Set(names)], sectionText: clean(section.innerText).slice(0, 400) };
}

/**
 * Whether a people-search page has actually rendered.
 *
 * Navigating to a search URL returns a shell that fills in afterwards, so a
 * read taken on arrival finds nobody and reports exactly that. The page is
 * ready once its own search box is there — the one with the "I'm looking for"
 * placeholder — or once there are results, or once it says there are none.
 *
 * Runs inside the page via page.evaluate.
 */
export function searchPageStateInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;

  // Rendered, not merely present: a page part way through loading can already
  // hold the markup with none of it on screen, and reading that finds nothing
  // while looking like a page that is ready.
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const box = [...document.querySelectorAll('input, [role="combobox"]')].find(
    (n) =>
      /looking for/i.test(n.getAttribute('placeholder') || n.getAttribute('aria-label') || '') && shown(n)
  );
  const people = [...main.querySelectorAll('a[href*="/in/"]')].filter(shown).length;
  const text = clean(main.innerText);
  const empty = /no results found|couldn't find anything|no matches/i.test(text);

  return {
    ready: !!box || people > 0 || empty,
    searchBox: !!box,
    people,
    empty,
    // Enough of the page to tell a loading shell from a real empty result.
    text: text.slice(0, 200),
  };
}
