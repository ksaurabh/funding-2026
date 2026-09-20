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
  const degreeAt = lines.findIndex((l) => DEGREE_LINE.test(l));
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
