#!/usr/bin/env node
// Replay the agent's parsing over pages it saved, with no LinkedIn involved.
//
//   node tools/parse-saved.mjs [file.html ...]
//   node tools/parse-saved.mjs --query "Greg Dracon@.406 Ventures"
//
// With no files it reads everything in data/linkedin-shots. This is how a
// misparse gets diagnosed: the agent keeps the page, this says what it made
// of it, and the fix is checked here before going anywhere near the site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extractPeopleInPage, extractProfileInPage } from '../server/linkedin/extract.js';
import { pickBest } from '../server/linkedin/match.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '..', 'data', 'linkedin-shots');

const args = process.argv.slice(2);
let query = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--query') {
    const [name, company = ''] = (args[++i] || '').split('@');
    query = { name: name.trim(), company: company.trim() };
  } else files.push(args[i]);
}
if (!files.length) {
  if (!fs.existsSync(SHOTS)) {
    console.error(`Nothing saved yet — ${SHOTS} does not exist.`);
    process.exit(1);
  }
  files.push(...fs.readdirSync(SHOTS).filter((f) => f.endsWith('.html')).map((f) => path.join(SHOTS, f)));
}
if (!files.length) {
  console.error('No saved HTML pages to parse.');
  process.exit(1);
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/parse-saved-'), {
  channel: 'chrome',
  headless: true,
});
const page = ctx.pages()[0] || (await ctx.newPage());

for (const file of files) {
  const full = path.resolve(file);
  await page.goto('file://' + full, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  const kind = /Search/i.test(title) ? 'people list' : 'profile';
  console.log(`\n${'='.repeat(72)}\n${path.basename(full)}  —  ${title}  [${kind}]`);

  // Every mutual-connections link on the page, whatever kind of page it is.
  const mutualLinks = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('a')]
      .map((a) => ({ text: clean(a.innerText), href: a.href }))
      .filter((l) => /mutual connections?$/i.test(l.text));
  });
  if (mutualLinks.length) {
    console.log(`\n  mutual-connections links (${mutualLinks.length}):`);
    for (const l of mutualLinks) console.log(`    "${l.text}"\n      ${l.href}`);
  } else {
    console.log('\n  mutual-connections links: none');
  }

  if (kind === 'profile') {
    const p = await page.evaluate(extractProfileInPage);
    console.log('\n  profile read:');
    console.log(`    name     ${p.name || '(none)'}`);
    console.log(`    degree   ${p.degree || '(none)'}`);
    console.log(`    headline ${p.headline || '(none)'}`);
    console.log(`    company  ${p.company || '(none)'}`);
    if (!p.name || !p.degree) console.log('    !! incomplete — the top card did not read cleanly');
    continue;
  }

  const people = await page.evaluate(extractPeopleInPage);
  console.log(`\n  people extracted: ${people.length}`);
  console.log(`    ${pad('name', 24)} ${pad('deg', 4)} ${pad('headline', 40)} mutual`);
  for (const p of people) {
    console.log(`    ${pad(p.name, 24)} ${pad(p.degree, 4)} ${pad(p.headline, 40)} ${p.mutual ? 'yes' : '-'}`);
  }
  const noName = people.filter((p) => !p.name).length;
  const noDegree = people.filter((p) => !p.degree).length;
  if (noName) console.log(`    !! ${noName} without a name`);
  if (noDegree) console.log(`    !! ${noDegree} without a degree — may be preview names, not results`);

  if (query) {
    const { best, accepted, all } = pickBest(query, people, 0.9);
    console.log(`\n  scored against "${query.name}" @ "${query.company}":`);
    for (const c of all.slice(0, 4)) {
      console.log(`    ${String(Math.round(c.confidence * 100)).padStart(3)}%  ${pad(c.name, 24)} ${c.mutual ? 'has mutual link' : ''}`);
    }
    console.log(`    -> ${accepted ? 'ACCEPT' : 'reject'} ${best?.name ?? ''}`);
    if (accepted && best.mutual) console.log(`    -> would open ${best.mutual.url}`);
    else if (accepted) console.log('    -> no mutual link on that card; would try the profile');
  }
}

await ctx.close();
