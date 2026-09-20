// Pulling people out of a LinkedIn results page without relying on its class
// names.
//
// The previous approach matched `reusable-search__*` classes, which LinkedIn
// renames. This walks the structure instead: every link to a profile is a
// person, and the block around it is their card. That survives a redesign.
//
// Runs inside the page via page.evaluate, so it must be self-contained.
export function extractPeopleInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const DEGREE = /(?:^|[^\w])(1st|2nd|3rd\+?)(?:[^\w]|$)/i;
  const MUTUAL = /mutual connections?$/i;

  // Prefer the main results region; fall back to the whole document.
  const root = document.querySelector('main') || document.body;

  const people = [];
  const seen = new Set();

  for (const a of root.querySelectorAll('a[href*="/in/"]')) {
    // Navigation chrome links to your own profile; those are not results.
    if (a.closest('nav, header, .global-nav')) continue;

    const href = a.href || '';
    const key = href.split('?')[0];
    if (!/\/in\/[^/?#]+/.test(key) || seen.has(key)) continue;

    // Climb to a block that holds the whole card, not just the name.
    let card = a.closest('li, [data-chameleon-result-urn], [data-view-name]') || a.parentElement;
    let hops = 0;
    while (card && card !== root && clean(card.innerText).length < 25 && hops++ < 4) {
      card = card.parentElement;
    }
    if (!card) continue;

    const text = clean(card.innerText);
    if (!text) continue;

    // The anchor's own text is usually the name; some markup nests it in a
    // span and repeats it for screen readers, so take the first line.
    const anchorText = clean(a.innerText).split('\n')[0];
    const lines = (card.innerText || '').split('\n').map(clean).filter(Boolean);
    const name = anchorText || lines[0] || '';
    if (!name || MUTUAL.test(name)) continue;

    // Whatever follows the name, minus the degree marker, reads as the
    // headline; the line after that is usually location or current company.
    const at = lines.findIndex((l) => l === name);
    const rest = at >= 0 ? lines.slice(at + 1) : lines.slice(1);
    const meaty = rest.filter((l) => !DEGREE.test(l) || l.replace(DEGREE, '').trim().length > 3);
    const headline = meaty[0] || '';
    const company = meaty[1] || '';

    const degreeMatch = DEGREE.exec(text);
    const mutualEl = [...card.querySelectorAll('a')].find((x) => MUTUAL.test(clean(x.innerText)));

    people.push({
      name,
      headline,
      company,
      degree: degreeMatch ? degreeMatch[1].toLowerCase().replace('3rd+', '3rd') : null,
      url: key,
      cardText: text.slice(0, 400),
      mutual: mutualEl ? { text: clean(mutualEl.innerText), url: mutualEl.getAttribute('href') || null } : null,
    });
    seen.add(key);
  }

  return people;
}
