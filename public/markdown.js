// A small Markdown renderer for LLM answers.
//
// It builds DOM nodes directly and never touches innerHTML, so nothing in an
// answer — including text a web search pulled in — can inject markup or script.
// Covers what answers actually use: headings, lists, tables, code, quotes,
// rules, links and the usual inline emphasis.

const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  return n;
};

// Only ever link somewhere the browser will treat as a plain web address.
function safeHref(url) {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![\w_])_([^_\n]+?)_(?![\w_])|~~([\s\S]+?)~~|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()[\]]+)/g;

/** Append the inline formatting of `text` to `parent`. */
function inline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const [, , code, bold1, bold2, em1, em2, strike, linkText, linkUrl, bareUrl] = m;

    if (code !== undefined) {
      parent.append(el('code', code.trim()));
    } else if (bold1 ?? bold2) {
      inline(parent.appendChild(el('strong')), bold1 ?? bold2);
    } else if (em1 ?? em2) {
      inline(parent.appendChild(el('em')), em1 ?? em2);
    } else if (strike) {
      inline(parent.appendChild(el('s')), strike);
    } else if (linkUrl) {
      const href = safeHref(linkUrl);
      if (href) {
        const a = el('a');
        Object.assign(a, { href, target: '_blank', rel: 'noreferrer noopener' });
        inline(a, linkText || linkUrl);
        parent.append(a);
      } else {
        parent.append(m[0]); // not a web link — leave it as written
      }
    } else if (bareUrl) {
      const href = safeHref(bareUrl);
      if (href) {
        const a = el('a', bareUrl);
        Object.assign(a, { href, target: '_blank', rel: 'noreferrer noopener' });
        parent.append(a);
      } else {
        parent.append(bareUrl);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** Render `src` as a DocumentFragment. */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const blocks = (stop) => {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];

      if (stop && stop(line)) break;

      // blank
      if (!line.trim()) {
        i++;
        continue;
      }

      // fenced code
      const fence = line.match(/^\s*(```+|~~~+)(.*)$/);
      if (fence) {
        const marker = fence[1][0].repeat(3);
        i++;
        const body = [];
        while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
        i++; // closing fence
        const pre = el('pre');
        pre.append(el('code', body.join('\n')));
        out.push(pre);
        continue;
      }

      // heading
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        const node = el(`h${h[1].length}`);
        inline(node, h[2]);
        out.push(node);
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
        out.push(el('hr'));
        i++;
        continue;
      }

      // table: a header row, a --- separator, then body rows
      if (isTableRow(line) && isTableRow(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
        const table = el('table');
        const thead = table.appendChild(el('thead'));
        const hr = thead.appendChild(el('tr'));
        for (const c of cells(line)) inline(hr.appendChild(el('th')), c);
        i += 2;
        const tbody = table.appendChild(el('tbody'));
        while (i < lines.length && isTableRow(lines[i])) {
          const tr = tbody.appendChild(el('tr'));
          for (const c of cells(lines[i])) inline(tr.appendChild(el('td')), c);
          i++;
        }
        out.push(table);
        continue;
      }

      // blockquote
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        const bq = el('blockquote');
        bq.append(renderMarkdown(quoted.join('\n')));
        out.push(bq);
        continue;
      }

      // list
      if (BULLET.test(line) || NUMBER.test(line)) {
        out.push(list(indentOf(line)));
        continue;
      }

      // paragraph: consecutive lines until something else starts
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !BULLET.test(lines[i]) &&
        !NUMBER.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*(```|~~~|#{1,6}\s)/.test(lines[i]) &&
        !isTableRow(lines[i])
      ) {
        para.push(lines[i++].trim());
      }
      if (para.length) {
        const p = el('p');
        inline(p, para.join(' '));
        out.push(p);
      } else {
        i++; // nothing matched; don't spin
      }
    }
    return out;
  };

  // A list at one indent level, recursing for anything indented further.
  function list(indent) {
    const ordered = NUMBER.test(lines[i]);
    const root = el(ordered ? 'ol' : 'ul');
    const start = ordered && lines[i].match(NUMBER)[1];
    if (ordered && start && start !== '1') root.setAttribute('start', start);

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // a blank line ends the list unless the next line continues it
        const next = lines[i + 1] || '';
        if (!BULLET.test(next) && !NUMBER.test(next)) break;
        i++;
        continue;
      }
      const m = line.match(BULLET) || line.match(NUMBER);
      if (!m || indentOf(line) < indent) break;
      if (indentOf(line) > indent) {
        // deeper bullet: nest it under the item we just added
        (root.lastElementChild || root.appendChild(el('li'))).append(list(indentOf(line)));
        continue;
      }

      const li = root.appendChild(el('li'));
      inline(li, m[m.length - 1]);
      i++;

      // continuation lines belonging to this item
      while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > indent && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) {
        li.append(' ');
        inline(li, lines[i++].trim());
      }
    }
    return root;
  }

  for (const node of blocks()) frag.append(node);
  return frag;
}
