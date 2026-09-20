import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
};
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
};
/**
 * A brief, non-blocking note. For things that happened and are reversible —
 * a dialog for those just gets in the way.
 */
function toast(message, tone = '') {
  let host = $('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const note = el('div', { className: 'toast ' + tone, textContent: message });
  host.append(note);
  setTimeout(() => note.classList.add('go'), 3200);
  setTimeout(() => note.remove(), 3700);
}

const post = (url, body) =>
  api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

/** $0.0043 and $12.40 should both read sensibly. */
/** Clock time in the viewer's own zone — the stored stamps are UTC. */
/** Mirrors the server's duration format, for the status pill. */
const humanMs = (ms) => {
  const total = Math.round(ms / 1000);
  if (total < 90) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const clock = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const money = (n) =>
  n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0.00';

const state = {
  lists: [],
  cost: null,
  playbooks: [],
  running: false,
  settings: null, // the saved defaults, for the run dialog to start from
  runConcurrency: null, // per-run overrides, remembered between runs
  runEffort: null,
  lastStepPick: null, // remembered tick state of the step picker
  // Which rows the current run is working on / still has queued.
  job: { listId: null, current: new Set(), pending: new Set() },
  listId: null,
  list: null,
  investors: { columns: [], csvColumns: [], rows: [], stepCount: 0 },
  schema: { fields: {} },
  valueFilters: {}, // { column: Set(selected values) }; '' means blank
  statusFilter: new Set(), // 'none' | 'partial' | 'complete' | 'errors'
  selection: new Set(), // row ids ticked in the table
  anchor: null, // last row clicked, for shift-click ranges
  playbook: null,
  selected: null,
  filter: '',
};

// ------------------------------------------------------------------ routing
// #/lists | #/list/<id>/investors | #/list/<id>/playbook | #/settings

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'lists').split('/');
  if (parts[0] === 'list' && parts[1]) return { view: parts[2] || 'investors', listId: parts[1] };
  const top = ['settings', 'playbooks', 'linkedin', 'network'].includes(parts[0]) ? parts[0] : 'lists';
  return { view: top, listId: null };
}

async function route() {
  const { view, listId } = parseHash();

  if (listId && listId !== state.listId) {
    state.listId = listId;
    state.selected = null;
    state.filter = '';
    state.valueFilters = {};
    state.statusFilter = new Set();
    state.selection = new Set();
    state.anchor = null;
    $('#search').value = '';
    $('#detail').replaceChildren(el('p', { className: 'muted pad', textContent: 'Select a row to see its answers.' }));
    try {
      await Promise.all([loadInvestors(), loadPlaybook()]);
    } catch (err) {
      alert(err.message);
      location.hash = '#/lists';
      return;
    }
  }
  if (!listId) state.listId = null;

  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== 'view-' + view);
  $('#list-tabs').classList.toggle('hidden', !listId);
  $('#crumb').textContent = listId && state.list ? state.list.name : '';
  for (const t of document.querySelectorAll('#list-tabs .tab')) {
    t.href = `#/list/${listId}/${t.dataset.view}`;
    t.classList.toggle('active', t.dataset.view === view);
  }
  // Home is the lists index, whether or not a list is open.
  $('#home-tab').classList.toggle('active', view === 'lists');
  $('#settings-tab').classList.toggle('active', view === 'settings');
  $('#playbooks-tab').classList.toggle('active', view === 'playbooks');
  $('#linkedin-tab').classList.toggle('active', view === 'linkedin');
  $('#network-tab').classList.toggle('active', view === 'network');
  $('#export').href = `/api/lists/${listId}/export.csv`;

  await loadCost();
  if (view === 'lists') await loadLists();
  if (view === 'playbooks') await loadPlaybookIndex();
  if (view === 'linkedin') {
    await fillLiListPickers();
    await pollLinkedIn();
  }
  if (view === 'network') await loadNetwork();
  if (view === 'playbook') {
    renderSteps(); // the column dropdowns depend on the current schema
    renderTokens();
    await fillPlaybookPicker();
  }
  if (view === 'settings') await loadSettings();
}

window.addEventListener('hashchange', route);

// -------------------------------------------------------------------- lists

async function loadCost() {
  try {
    state.cost = await api('/api/cost');
  } catch {
    return;
  }
  const c = state.cost;
  $('#spend').textContent = `${money(c.total)}${c.unknown ? '+' : ''} spent`;
  $('#spend').title =
    `${c.calls} model call${c.calls === 1 ? '' : 's'} across all lists` +
    (c.unknown ? ' — some used a model with no price on file, so the real total is higher.' : '');

  const list = c.byList.find((l) => l.id === state.listId);
  $('#list-spend').textContent = list && list.calls ? `· ${money(list.cost)} spent on this list` : '';
}

async function loadLists() {
  state.lists = await api('/api/lists');
  await loadCost();
  const grid = $('#list-grid');

  if (!state.lists.length) {
    grid.replaceChildren(
      el('p', { className: 'muted', textContent: 'No lists yet. Import a CSV to get started — the first column is used as the name of each row.' })
    );
    return;
  }

  grid.replaceChildren(
    ...state.lists.map((l) => {
      const pct = l.rowCount ? Math.round((l.answered / l.rowCount) * 100) : 0;
      const card = el('div', { className: 'card' }, [
        el('h3', {}, [el('a', { href: `#/list/${l.id}/investors`, textContent: l.name })]),
        el('div', {
          className: 'muted small',
          textContent:
            `${l.rowCount} rows · ${l.columns.length} columns · ` +
            (l.playbookName ? `${l.playbookName} (${l.stepCount} steps)` : 'no playbook') +
            (l.source ? ` · ${l.source}` : ''),
        }),
        el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })),
        el('div', {
          className: 'muted small',
          textContent: l.stepCount
            ? `${l.answered} of ${l.rowCount} fully researched` +
              (l.errors ? ` · ${l.errors} with errors` : '') +
              (l.calls ? ` · ${money(l.cost)}${l.costUnknown ? '+' : ''} spent` : '') +
              (l.lastRun ? ` · last run ${new Date(l.lastRun).toLocaleString()}` : '')
            : l.playbookName
            ? 'That playbook has no enabled steps yet'
            : 'No playbook attached yet',
        }),
        el('div', { className: 'card-actions' }, [
          el('a', { className: 'btn primary', href: `#/list/${l.id}/investors`, textContent: 'Research' }),
          el('a', { className: 'btn', href: `#/list/${l.id}/playbook`, textContent: 'Playbook' }),
          el('a', { className: 'btn', href: `/api/lists/${l.id}/export.csv`, textContent: 'Download' }),
          button('Rename', '', async () => {
            const name = prompt('List name', l.name);
            if (!name) return;
            await api(`/api/lists/${l.id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            loadLists();
          }),
          button('Delete', 'danger', async () => {
            if (!confirm(`Delete "${l.name}" and all of its answers?`)) return;
            try {
              await api(`/api/lists/${l.id}`, { method: 'DELETE' });
            } catch (err) {
              return alert(err.message);
            }
            loadLists();
          }),
        ]),
      ]);
      return card;
    })
  );
}

$('#import-new').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const name = prompt('Name this list', f.name.replace(/\.csv$/i, '')) || f.name;
    const created = await post('/api/lists', { csv: await f.text(), name, source: f.name });
    location.hash = `#/list/${created.id}/playbook`;
  } catch (err) {
    alert(err.message);
  }
});

// ---------------------------------------------------------------- investors

/**
 * The LinkedIn contacts, indexed for matching against list rows: by person
 * and company together, and by person alone as a fallback.
 */
async function loadLinkedInIndex() {
  let contacts = [];
  try {
    contacts = await api('/api/linkedin/contacts');
  } catch {
    return;
  }
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  state.liByPair = new Map();
  state.liByName = new Map();
  for (const c of contacts) {
    const person = norm(c.queriedAs || c.name);
    if (!person) continue;
    for (const co of [c.queriedCompany, c.company]) {
      if (co) state.liByPair.set(`${person}|${norm(co)}`, c);
    }
    // Only useful while a name is unambiguous.
    state.liByName.set(person, state.liByName.has(person) ? null : c);
  }
}

/** The LinkedIn contact matching this row, via the list's column mapping. */
function contactForRow(row) {
  const map = linkedinMapping();
  if (!map || !state.liByPair) return null;
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const person = norm(row[map.nameColumn]);
  if (!person) return null;
  const company = norm(map.companyColumn ? row[map.companyColumn] : '');
  return state.liByPair.get(`${person}|${company}`) || state.liByName.get(person) || null;
}

async function loadInvestors() {
  await loadLinkedInIndex();
  state.investors = await api(`/api/lists/${state.listId}/investors`);
  state.list = state.investors.list;
  state.schema = state.investors.schema || { fields: {} };
  // A column that is no longer on the filter bar must stop narrowing the list.
  for (const col of Object.keys(state.valueFilters)) {
    if (!filterColumns().includes(col)) delete state.valueFilters[col];
  }
  renderFilters();
  renderTable();
}

// Keyed by column name. Tolerates the older array shape in case a stale page
// and a new server (or the reverse) ever meet.
const fields = () => {
  const f = state.schema?.fields;
  return Array.isArray(f) ? Object.fromEntries(f.map((x) => [x.name, x])) : f || {};
};
const fieldFor = (col) => fields()[col];
// In the list's own column order, not the object's.
const columnsWhere = (pred) => (state.investors.columns || []).filter((c) => fields()[c] && pred(fields()[c]));
const enumColumns = () => columnsWhere((f) => f.editable && f.type === 'enum');

// Filtering is a read: any column can be filtered on, dropdown or not. Only
// columns with a workable number of distinct values are worth offering.
const FILTERABLE_MAX = 60;
// Matches the server: a dropdown joins the filter bar on its own only if its
// chips make a short row. Longer ones you add deliberately.
const MAX_AUTO_FILTER = 10;

/** Value -> count for one column, over the whole list. */
function valueCounts(column) {
  const counts = new Map();
  for (const r of state.investors.rows) {
    const v = cellValue(r, column);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

const distinctCount = (column) => [...valueCounts(column).keys()].filter((v) => v !== '').length;

/** Columns currently on the filter bar. */
const filterColumns = () => columnsWhere((f) => f.filter);

/** Columns that could be added to it. */
const filterCandidates = () =>
  (state.investors.columns || []).filter(
    (c) => fields()[c] && !fields()[c].filter && distinctCount(c) > 0 && distinctCount(c) <= FILTERABLE_MAX
  );

/** Change one column's settings from outside the Columns dialog. */
async function patchField(column, patch) {
  const next = {};
  for (const [name, f] of Object.entries(fields())) next[name] = name === column ? { ...f, ...patch } : f;
  state.schema = await api(`/api/lists/${state.listId}/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: next, order: state.investors.columns }),
  });
  await loadInvestors();
}
const editableColumns = () => columnsWhere((f) => f.editable);
const shownColumns = () => columnsWhere((f) => f.show);
const cellValue = (row, col) => String(row[col] ?? '').trim();

/** Keep the table's copy of a row in step with an edit made anywhere. */
function applyCellLocally(rowId, column, value) {
  const row = state.investors.rows.find((r) => r.__id === rowId);
  if (row) row[column] = value;
}

async function saveCell(rowId, column, value) {
  const r = await api(`/api/lists/${state.listId}/investors/${rowId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ column, value }),
  });
  state.schema = { fields: r.fields };
  return r.value;
}

function matchesValueFilters(row) {
  // Within a column: any selected value matches. Across columns: all must match.
  for (const [col, chosen] of Object.entries(state.valueFilters)) {
    if (!chosen.size) continue;
    if (!chosen.has(cellValue(row, col))) return false;
  }
  return true;
}

const isFiltered = () =>
  !!state.filter.trim() ||
  state.statusFilter.size > 0 ||
  Object.values(state.valueFilters).some((v) => v.size);

/** How far through the playbook a row is. A row can be both partial and errored. */
const STATUSES = [
  { key: 'none', label: 'Not started', test: (r, n) => r.__done === 0 && !r.__errors },
  { key: 'partial', label: 'Partial', test: (r, n) => r.__done > 0 && r.__done < n },
  { key: 'complete', label: 'Complete', test: (r, n) => n > 0 && r.__done >= n },
  { key: 'errors', label: 'Has errors', test: (r) => r.__errors > 0 },
];

function matchesStatus(row) {
  if (!state.statusFilter.size) return true;
  const n = state.investors.stepCount;
  return STATUSES.some((s) => state.statusFilter.has(s.key) && s.test(row, n));
}

function visibleRows() {
  const q = state.filter.trim().toLowerCase();
  return state.investors.rows.filter((r) => {
    if (!matchesStatus(r)) return false;
    if (!matchesValueFilters(r)) return false;
    if (!q) return true;
    return state.investors.columns.some((c) => String(r[c] ?? '').toLowerCase().includes(q));
  });
}

function filtersOpen() {
  try {
    return localStorage.getItem('filtersCollapsed') !== '1';
  } catch {
    return true;
  }
}

function setFiltersOpen(open) {
  try {
    localStorage.setItem('filtersCollapsed', open ? '0' : '1');
  } catch {
    /* private window; the section just reopens next time */
  }
  $('#filter-groups').classList.toggle('hidden', !open);
  $('#filters-toggle').setAttribute('aria-expanded', String(open));
  $('#filters-toggle').classList.toggle('closed', !open);
}

$('#filters-toggle').addEventListener('click', () => setFiltersOpen(!filtersOpen()));

/** One row per column: a label, then that column's chips. */
function filterGroup(label, chips, onRemove) {
  const head = el('span', { className: 'filter-label' }, [
    el('span', { className: 'filter-label-text', textContent: label, title: label }),
  ]);
  if (onRemove) {
    const x = el('button', { className: 'drop-filter', textContent: '×', title: `Remove the ${label} filter` });
    x.addEventListener('click', onRemove);
    head.append(x);
  }
  return el('div', { className: 'filter-group' }, [head, el('div', { className: 'chips' }, chips)]);
}

/** How many rows survive every filter together, the search box included. */
function updateFilterCount() {
  const count = $('#filter-count');
  if (!count) return;
  const total = state.investors.rows.length;
  const matched = visibleRows().length;
  count.textContent = isFiltered()
    ? `${matched.toLocaleString()} of ${total.toLocaleString()} rows match`
    : `${total.toLocaleString()} rows`;
  count.classList.toggle('active', isFiltered());
}

function renderFilters() {
  const bar = $('#filters');
  const cols = filterColumns();
  const available = filterCandidates();
  const n = state.investors.stepCount;
  bar.classList.toggle('hidden', !cols.length && !available.length && !n);
  if (!cols.length && !available.length && !n) return;

  const groups = [];

  // Progress through the playbook.
  if (n) {
    groups.push(
      filterGroup(
        'Answers',
        STATUSES.map((st) => {
          const count = state.investors.rows.filter((r) => st.test(r, n)).length;
          const chip = el('button', {
            className: 'chip' + (state.statusFilter.has(st.key) ? ' on' : ''),
            textContent: `${st.label} ${count}`,
          });
          chip.addEventListener('click', () => {
            state.statusFilter.has(st.key) ? state.statusFilter.delete(st.key) : state.statusFilter.add(st.key);
            renderFilters();
            renderTable();
          });
          return chip;
        })
      )
    );
  }

  // One row per dropdown column.
  for (const col of cols) {
    const counts = valueCounts(col);
    const chosen = state.valueFilters[col] || new Set();
    const values = [...new Set([...(fieldFor(col)?.values || []), ...counts.keys()])].filter((v) => v !== '');
    if (counts.get('')) values.push('');

    groups.push(
      filterGroup(
        col || '(unnamed column)',
        values.map((v) => {
          const chip = el('button', {
            className: 'chip' + (chosen.has(v) ? ' on' : ''),
            textContent: `${v === '' ? '(blank)' : v} ${counts.get(v) || 0}`,
          });
          chip.addEventListener('click', () => {
            const set = (state.valueFilters[col] ||= new Set());
            set.has(v) ? set.delete(v) : set.add(v);
            renderFilters();
            renderTable();
          });
          return chip;
        }),
        () => {
          delete state.valueFilters[col];
          patchField(col, { filter: false });
        }
      )
    );
  }

  // Bring a dropdown column back onto the bar.
  const picker = $('#add-filter');
  picker.classList.toggle('hidden', !available.length);
  picker.replaceChildren(
    el('option', { value: '', textContent: '+ Add filter' }),
    ...available.map((c) =>
      el('option', { value: c, textContent: `${c || '(unnamed column)'} (${distinctCount(c)})` })
    )
  );

  $('#filter-groups').replaceChildren(...groups);

  // The head stays useful while collapsed: it names what is narrowing the list.
  const activeBits = [];
  if (state.statusFilter.size) {
    activeBits.push(
      'Answers: ' + STATUSES.filter((s) => state.statusFilter.has(s.key)).map((s) => s.label).join(', ')
    );
  }
  for (const [col, set] of Object.entries(state.valueFilters)) {
    if (set.size) activeBits.push(`${col || '(unnamed)'}: ${[...set].map((v) => v || '(blank)').join(', ')}`);
  }
  $('#filters-summary').textContent = activeBits.length ? `Filters — ${activeBits.join(' · ')}` : 'Filters';
  $('#filters-summary').parentElement.classList.toggle('active', activeBits.length > 0);
  $('#clear-filters').classList.toggle('hidden', !activeBits.length);

  updateFilterCount();

  setFiltersOpen(filtersOpen());
}

$('#add-filter').addEventListener('change', (e) => {
  const col = e.target.value;
  e.target.value = '';
  if (col) patchField(col, { filter: true });
});

$('#clear-filters').addEventListener('click', () => {
  state.valueFilters = {};
  state.statusFilter = new Set();
  renderFilters();
  renderTable();
});

/**
 * A run's progress poll rebuilds the table every couple of seconds. If that
 * happens while a cell is being edited it destroys the control mid-use — an
 * open dropdown closes by itself, a half-typed value is lost. So renders are
 * held back while an editor has focus and replayed once it is done.
 */
const editorFocused = () => !!document.activeElement?.closest?.('.cell-edit, .field-row');
let renderDeferred = false;

document.addEventListener('focusout', () => {
  // Let focus settle: moving between two cells should not trigger a redraw.
  setTimeout(() => {
    if (renderDeferred && !editorFocused()) {
      renderDeferred = false;
      renderTable();
    }
  }, 0);
});

const TICK_W = 30;
const STATUS_W = 92;
/** Unset columns get a sensible default: the first one wider, the rest even. */
const defaultWidth = (index) => (index === 0 ? 240 : 160);
const widthOf = (col, index) => fieldFor(col)?.width || defaultWidth(index);

/** Rebuild the <colgroup> so every column honours its width. */
function applyWidths(shown, linked) {
  const cols = [
    el('col', { style: `width:${TICK_W}px` }),
    ...shown.map((c, i) => el('col', { style: `width:${widthOf(c, i)}px` })),
    ...(linked ? [el('col', { style: 'width:150px' }), el('col', { style: 'width:190px' })] : []),
    el('col', { style: `width:${STATUS_W}px` }),
  ];
  let group = $('#investor-table colgroup');
  if (!group) {
    group = el('colgroup');
    $('#investor-table').prepend(group);
  }
  group.replaceChildren(...cols);
  return group;
}

/** Drag the right edge of a header cell to resize that column. */
function resizeHandle(col, index, group) {
  const handle = el('div', { className: 'col-resize', title: 'Drag to resize' });

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(col, index);
    const target = group.children[index + 1]; // +1 for the tick column
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');

    let latest = startW;
    const onMove = (ev) => {
      latest = Math.max(60, Math.min(800, Math.round(startW + ev.clientX - startX)));
      target.style.width = `${latest}px`;
    };
    const onUp = async () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.classList.remove('dragging');
      if (latest !== startW) await patchField(col, { width: latest });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  // Double-click clears the width back to the default.
  handle.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    patchField(col, { width: null });
  });
  return handle;
}

/** Shift-click: apply the clicked state across the visible span. */
function rangeSelect(fromId, toId, checked) {
  const rows = visibleRows();
  const a = rows.findIndex((r) => r.__id === fromId);
  const b = rows.findIndex((r) => r.__id === toId);
  if (a < 0 || b < 0) return;
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    if (checked) state.selection.add(rows[i].__id);
    else state.selection.delete(rows[i].__id);
  }
}

/** How far away this row's person is, or a way to find out. */
function connectionCell(row) {
  const c = contactForRow(row);

  if (c?.degree) {
    return el('span', {
      className: `badge deg-${c.degree}`,
      textContent: c.degree,
      title: (DEGREE_LABEL[c.degree] || '') + (c.name ? ` — ${c.name}` : ''),
    });
  }

  const working = c && (c.status === 'running' || c.status === 'queued');
  if (working) {
    return el('span', { className: 'badge running' }, [
      el('i', { className: 'spinner' }),
      document.createTextNode('looking'),
    ]);
  }

  const look = button('Look up on LinkedIn', 'linkish', (e) => {
    e?.stopPropagation?.();
    findPathForRow(row);
  });
  look.title = c
    ? `Looked up as ${c.name}, but no degree was established — run it again`
    : 'Queue this person for a LinkedIn path lookup';
  return look;
}

/** Who could introduce you to this row's person. */
function viaCell(row) {
  const c = contactForRow(row);
  const via = c?.via || [];
  if (!via.length) return el('span', { className: 'muted', textContent: c?.degree === '1st' ? 'direct' : '—' });

  const names = via.map((v) => v.name);
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` +${names.length - 2}` : '';
  return el('span', {
    textContent: shown + more,
    title: names.join('\n'),
  });
}

/** An editable table cell: a dropdown for enum columns, an input for text. */
function editableCell(row, column, field) {
  const current = cellValue(row, column);

  if (field.type === 'text') {
    const input = el('input', {
      type: 'text',
      className: 'cell-input',
      value: current,
      title: current,
      placeholder: '—',
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    const commit = async () => {
      const value = input.value.trim();
      if (value === current) return;
      try {
        await saveCell(row.__id, column, value);
        row[column] = value;
        applyCellLocally(row.__id, column, value);
        renderTable();
      } catch (err) {
        alert(err.message);
        input.value = current;
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = current;
        input.blur();
      }
    });
    return input;
  }

  const choices = [...new Set([...field.values, ...(current ? [current] : [])])];
  const sel = el('select', { className: 'cell-select' }, [
    el('option', { value: '', textContent: '—', selected: !current }),
    ...choices.map((v) => el('option', { value: v, textContent: v, selected: v === current })),
    el('option', { value: '\u0000new', textContent: '+ New value…' }),
  ]);
  sel.addEventListener('click', (e) => e.stopPropagation()); // don't open the detail pane
  sel.addEventListener('change', async () => {
    let value = sel.value;
    if (value === '\u0000new') {
      value = (prompt(`New value for "${column}"`) || '').trim();
      if (!value) {
        sel.value = current;
        return;
      }
    }
    try {
      await saveCell(row.__id, column, value);
      row[column] = value;
      applyCellLocally(row.__id, column, value);
      renderFilters();
      renderTable();
    } catch (err) {
      alert(err.message);
      sel.value = current;
    }
  });
  return sel;
}

function renderTable() {
  if (editorFocused()) {
    renderDeferred = true;
    return;
  }
  const { stepCount = 0 } = state.investors;
  const shown = shownColumns();
  const rowsForHead = visibleRows();
  const allTicked = rowsForHead.length > 0 && rowsForHead.every((r) => state.selection.has(r.__id));
  const someTicked = !allTicked && rowsForHead.some((r) => state.selection.has(r.__id));
  const selectAll = el('input', { type: 'checkbox', checked: allTicked, title: 'Select all shown rows' });
  selectAll.indeterminate = someTicked;
  selectAll.addEventListener('change', () => {
    for (const r of rowsForHead) {
      if (selectAll.checked) state.selection.add(r.__id);
      else state.selection.delete(r.__id);
    }
    renderTable();
  });

  const linked = !!linkedinMapping();
  const group = applyWidths(shown, linked);
  $('#investor-table thead').replaceChildren(
    el('tr', {}, [
      el('th', { className: 'tick' }, selectAll),
      ...shown.map((c, i) =>
        el('th', {}, [el('span', { className: 'th-text', textContent: c, title: c }), resizeHandle(c, i, group)])
      ),
      linked ? el('th', { textContent: 'Connection' }) : null,
      linked ? el('th', { textContent: 'Connected via' }) : null,
      el('th', { textContent: 'Answers' }),
    ].filter(Boolean))
  );

  const rows = visibleRows();
  const picked = state.selection.size;
  $('#count').textContent =
    `${rows.length} of ${state.investors.rows.length} rows` + (picked ? ` · ${picked} selected` : '');
  $('#clear-selection').classList.toggle('hidden', !picked);
  renderRunButtons(rows);

  $('#investor-table tbody').replaceChildren(
    ...rows.map((r) => {
      const active = state.job.listId === state.listId && state.job.current.has(r.__id);
      const queued = state.job.listId === state.listId && state.job.pending.has(r.__id);

      const status = active
        ? el('span', { className: 'badge running', title: 'Running now' }, [
            el('i', { className: 'spinner' }),
            document.createTextNode(stepCount ? `${r.__done}/${stepCount}` : 'running'),
          ])
        : el('span', {
            className:
              'badge ' +
              (queued ? 'queued' : r.__errors ? 'err' : stepCount && r.__done >= stepCount ? 'full' : ''),
            title: queued ? 'Queued in this run' : '',
            textContent: stepCount ? `${r.__done}/${stepCount}` : '—',
          });
      const tick = el('input', { type: 'checkbox', checked: state.selection.has(r.__id) });
      tick.addEventListener('click', (e) => {
        e.stopPropagation(); // ticking a row should not open its detail pane
        if (e.shiftKey && state.anchor) rangeSelect(state.anchor, r.__id, tick.checked);
        else if (tick.checked) state.selection.add(r.__id);
        else state.selection.delete(r.__id);
        state.anchor = r.__id;
        renderTable();
      });

      const tr = el('tr', {
        className:
          (r.__id === state.selected ? 'selected ' : '') +
          (state.selection.has(r.__id) ? 'ticked ' : '') +
          (active ? 'active' : queued ? 'queued' : ''),
      }, [
        el('td', { className: 'tick' }, tick),
        ...shown.map((c) => {
          const f = fieldFor(c);
          return f?.editable
            ? el('td', { className: 'cell-edit' }, editableCell(r, c, f))
            : el('td', { textContent: r[c] ?? '', title: r[c] ?? '' });
        }),
        ...(linked ? [el('td', {}, connectionCell(r)), el('td', {}, viaCell(r))] : []),
        el('td', {}, status),
      ].filter(Boolean));
      tr.addEventListener('click', () => selectInvestor(r.__id));
      return tr;
    })
  );
}

function renderRunButtons(rows) {
  const filtered = isFiltered();
  const target = runTarget(rows);
  const unanswered = target.rows.filter((r) => r.__done < state.investors.stepCount);

  const all = $('#run-all');
  all.textContent = target.selected
    ? `Run ${target.rows.length} selected`
    : filtered
    ? `Run ${rows.length} filtered`
    : `Run all ${rows.length}`;
  all.disabled = !target.rows.length || state.running;
  all.title = target.selected
    ? 'Run the playbook on the ticked rows, wherever they are in the list'
    : filtered
    ? 'Run the playbook on the rows matching the current filter'
    : 'Run the playbook on every row in this list';

  // Name the set these act on, so the selection is visible in the button.
  const scope = target.selected ? 'selected' : filtered ? 'filtered' : '';
  const of = scope ? ` of ${target.rows.length} ${scope}` : '';
  const partial = target.rows.filter((r) => r.__done > 0 && r.__done < state.investors.stepCount);

  // Fill gaps never redoes finished work: per row, only its missing steps run.
  const gaps = $('#fill-gaps');
  gaps.textContent = scope ? `Fill gaps in ${unanswered.length} ${scope}` : `Fill gaps (${unanswered.length})`;
  gaps.disabled = !unanswered.length || state.running;
  gaps.title =
    `Run only the steps with no answer yet, on the ${unanswered.length} row(s)${of} that are missing any` +
    (partial.length ? ` — ${partial.length} part-way through` : '') +
    '. Steps already evaluated are skipped, not re-asked.';

  const paths = $('#find-paths');
  paths.textContent = scope ? `Find LinkedIn paths (${target.rows.length} ${scope})` : 'Find LinkedIn paths';
  paths.disabled = !target.rows.length;
  const liMap = linkedinMapping();
  paths.title = liMap
    ? `Queue the people in "${liMap.nameColumn}" for a LinkedIn path lookup`
    : 'Queue these rows for a LinkedIn path lookup — you pick the name column once';

  const rest = $('#run-unanswered');
  rest.textContent = scope ? `Run unanswered ${scope} (${unanswered.length})` : `Run unanswered (${unanswered.length})`;
  rest.disabled = !unanswered.length || state.running;
  rest.title =
    `Re-run the whole playbook on the ${unanswered.length} row(s)${of} missing any answer, ` +
    'replacing the answers already there.';
}

/**
 * What a run should cover: the ticked rows if any (regardless of the current
 * filter, since you picked them deliberately), otherwise what is on screen.
 */
function runTarget(rows = visibleRows()) {
  if (state.selection.size) {
    const byId = new Map(state.investors.rows.map((r) => [r.__id, r]));
    return { selected: true, rows: [...state.selection].map((id) => byId.get(id)).filter(Boolean) };
  }
  return { selected: false, rows };
}

async function selectInvestor(id) {
  state.selected = id;
  renderTable();
  const data = await api(`/api/lists/${state.listId}/investors/${id}`);
  const name = data.investor[data.columns[0]];

  const head = el('div', { className: 'detail-head' }, [
    el('h2', { textContent: name }),
    state.job.listId === state.listId && state.job.current.has(id)
      ? el('div', { className: 'meta running' }, [
          el('i', { className: 'spinner' }),
          document.createTextNode('Running now…'),
        ])
      : el('div', {
          className: 'meta',
          textContent: data.updatedAt ? 'Last run ' + new Date(data.updatedAt).toLocaleString() : 'Never run',
        }),
    el('div', { className: 'actions' }, [
      button('Run playbook on this row', 'primary', () => run({ investorIds: [id] })),
      button('Find LinkedIn path', '', () => findPathForRow(data.investor)),
      button('Clear answers', 'danger', async () => {
        await api(`/api/lists/${state.listId}/investors/${id}/answers`, { method: 'DELETE' });
        await loadInvestors();
        selectInvestor(id);
      }),
    ]),
  ]);

  const answers = data.steps.map((s) => {
    const a = s.answer;
    let body;
    if (a?.error) {
      body = el('div', { className: 'body error', textContent: '⚠ ' + a.error });
    } else if (a?.text) {
      body = el('div', { className: 'body md' });
      body.append(renderMarkdown(a.text));
    } else {
      body = el('div', { className: 'body empty', textContent: 'No answer yet.' });
    }

    const parts = [
      el('h4', {}, [
        document.createTextNode(s.name),
        s.webSearch ? el('span', { className: 'badge', textContent: 'web' }) : null,
        a?.truncated ? el('span', { className: 'badge err', textContent: 'truncated' }) : null,
      ]),
      body,
    ];

    if (a?.citations?.length) {
      parts.push(
        el('div', { className: 'cites' }, [
          el('strong', { textContent: 'Sources' }),
          ...a.citations.map((c) =>
            el('a', { href: c.url, target: '_blank', rel: 'noreferrer', textContent: c.title || c.url })
          ),
        ])
      );
    }
    if (a?.cost || a?.usage) {
      parts.push(
        el('div', {
          className: 'muted small',
          textContent:
            `${money(a.cost || 0)}${a.costUnknown ? '+' : ''} · ` +
            `${a.usage?.input ?? 0} in / ${a.usage?.output ?? 0} out tokens · ${a.model || ''}`,
        })
      );
    }
    if (a?.wroteTo) {
      parts.push(
        el('div', { className: 'wrote' }, [
          el('span', { className: 'muted small', textContent: `${a.wroteTo.column} → ` }),
          el('span', { className: 'badge full', textContent: a.wroteTo.value || '(blank)' }),
        ])
      );
    }
    if (a?.writeError) {
      parts.push(el('div', { className: 'body error small', textContent: `⚠ column not filled: ${a.writeError}` }));
    }
    if (a?.prompt) {
      parts.push(requestDetails(id, s));
    }
    parts.push(
      el('div', { className: 'actions', style: 'margin-top:8px' }, [
        button('Re-run this step', '', () => run({ investorIds: [id], stepIds: [s.id] })),
      ])
    );
    return el('div', { className: 'answer' }, parts);
  });

  // The row's own columns, in the order set in Columns… — editable ones
  // stay editable here, so the detail pane is a full view of the row.
  const rowFields = el('div', { className: 'answer fields' }, [
    el('h4', { textContent: 'Fields' }),
    ...data.columns.map((c) => {
      const f = data.schema?.fields?.[c];
      const value = f?.editable
        ? editableCell(data.investor, c, f)
        : el('span', { className: 'field-value', textContent: data.investor[c] || '—' });
      return el('div', { className: 'field-row' }, [
        el('span', { className: 'field-name', textContent: c || '(unnamed)', title: c }),
        value,
      ]);
    }),
  ]);

  $('#detail').replaceChildren(head, rowFields, ...answers);
}

/** Roughly what a chunk of text costs in tokens; good enough to apportion. */
const approxTokens = (chars) => Math.round(chars / 3.7);

/**
 * "What was sent" for one step, loaded when opened: the system prompt, the
 * whole thread, and everything the model pulled in on its own — which is
 * usually where a surprising input-token count comes from.
 */
function requestDetails(rowId, step) {
  const box = el('details', { className: 'request' });
  box.append(el('summary', { textContent: 'What was sent' }));
  const body = el('div', { className: 'request-body muted', textContent: 'Loading…' });
  box.append(body);

  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    let r;
    try {
      r = await api(`/api/lists/${state.listId}/investors/${rowId}/steps/${step.id}/request`);
    } catch (err) {
      body.textContent = err.message;
      return;
    }

    const promptTok = approxTokens(r.promptChars);
    const totalIn = r.usage?.input || 0;
    const nodes = [];

    // Where the input tokens went. Only the prompt side is measurable from
    // here, so say what is known and label the remainder honestly.
    const searchTok = approxTokens(r.searchChars);
    const results = r.searches.reduce((n, x) => n + x.results, 0);
    const lines = [
      el('div', {
        textContent:
          `${totalIn.toLocaleString()} input tokens were billed for this step. ` +
          `The prompt and thread below are only about ${promptTok.toLocaleString()} of them.`,
      }),
    ];

    if (r.searches.length) {
      lines.push(
        el('div', {
          textContent:
            `The model ran ${r.searches.length} web search${r.searches.length === 1 ? '' : 'es'} while answering and ` +
            `read ${results} result${results === 1 ? '' : 's'} — roughly ${searchTok.toLocaleString()} tokens of ` +
            'page content that never appears in the prompt you wrote. That is where the bulk of the count comes from.',
        })
      );
    } else {
      lines.push(
        el('div', {
          className: 'muted',
          textContent: 'Web search was off for this step, so nothing was fetched.',
        })
      );
    }

    lines.push(
      el('div', {
        className: 'muted small',
        textContent:
          `The remainder (~${Math.max(0, totalIn - promptTok - (r.searches.length ? searchTok : 0)).toLocaleString()}) ` +
          'is the tool definitions, per-message overhead and the model\u2019s own thinking, which the API bills as ' +
          'input but does not break out. Prompt and search figures here are estimates from character counts.',
      })
    );

    if (r.resumes) {
      lines.push(
        el('div', {
          className: 'muted small',
          textContent: `The turn was resumed ${r.resumes}\u00d7 while the model worked, each resume re-sending the thread.`,
        })
      );
    }

    nodes.push(el('div', { className: 'budget' }, lines));

    for (const search of r.searches) {
      const d = el('details', { className: 'search' });
      d.append(
        el('summary', {
          textContent:
            `🔍 ${search.query || '(no query recorded)'} — ` +
            (search.error ? `failed: ${search.error}` : `${search.results} results, ~${approxTokens(search.chars).toLocaleString()} tokens`),
        })
      );
      for (const src of search.sources || []) {
        d.append(
          el('a', { href: src.url, target: '_blank', rel: 'noreferrer noopener', textContent: src.title || src.url })
        );
      }
      nodes.push(d);
    }

    // The thread itself.
    nodes.push(el('h5', { textContent: `System prompt · ${r.model}` }));
    nodes.push(el('pre', { textContent: r.system || '(none)' }));
    if (r.mode === 'conversation' && r.messages.length > 1) {
      nodes.push(
        el('p', {
          className: 'muted small',
          textContent: 'Conversation mode: earlier steps of this run were replayed as part of the thread.',
        })
      );
    }
    for (const m of r.messages) {
      nodes.push(
        el('h5', { className: m.current ? 'current' : '' }, [
          document.createTextNode(`${m.role === 'user' ? 'You' : 'Model'} · ${m.stepName}`),
          m.current ? el('span', { className: 'badge', textContent: 'this step' }) : null,
        ])
      );
      nodes.push(el('pre', { textContent: m.content || '(empty)' }));
    }

    body.classList.remove('muted');
    body.replaceChildren(...nodes.filter(Boolean));
  });

  return box;
}

function button(text, cls, onClick) {
  const b = el('button', { textContent: text, className: cls });
  b.addEventListener('click', onClick);
  return b;
}

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  updateFilterCount();
  renderTable();
});

// --------------------------------------------------- editable-column config

$('#columns-btn').addEventListener('click', async () => {
  await renderColumnConfig();
  $('#columns-dialog').showModal();
});

$('#columns-dialog').addEventListener('close', () => loadInvestors());

async function saveSchema(fields, order) {
  state.schema = await api(`/api/lists/${state.listId}/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields, order: order || Object.keys(fields) }),
  });
  await renderColumnConfig();
}

/** The chips + "add a value" row for a dropdown column. */
function valueEditor(name, field, all) {
  const withValues = (values) => saveSchema({ ...all, [name]: { ...field, values } });

  const chips = el('div', { className: 'tokens' }, [
    ...field.values.map((v) => {
      const chip = el('button', { className: 'chip removable', textContent: v });
      chip.append(el('i', { textContent: '×' }));
      chip.addEventListener('click', () => withValues(field.values.filter((n) => n !== v)));
      return chip;
    }),
    field.values.length ? null : el('span', { className: 'muted small', textContent: 'No choices yet.' }),
  ]);

  const input = el('input', { type: 'text', placeholder: 'Add a value…' });
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    withValues([...field.values, v]);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });

  return [chips, el('div', { className: 'add-value' }, [input, button('Add', '', add)])];
}

async function renderColumnConfig() {
  const info = await api(`/api/lists/${state.listId}/schema`);
  state.schema = { fields: info.fields };
  const all = info.fields;

  const order = info.order || info.columns.map((c) => c.name);
  const move = (name, delta) => {
    const next = [...order];
    const i = next.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= next.length) return;
    next.splice(j, 0, next.splice(i, 1)[0]);
    saveSchema(all, next);
  };

  const rows = info.columns.map((c, index) => {
    const field = all[c.name] || { editable: !c.imported, type: 'text', values: [], custom: !c.imported, show: true };
    const update = (patch) => saveSchema({ ...all, [c.name]: { ...field, ...patch } });

    const show = el('input', { type: 'checkbox', checked: field.show });
    show.addEventListener('change', () => update({ show: show.checked }));

    // Filtering does not need the column to be editable — it only reads.
    const tooVaried = c.distinct.length > 60 || c.tooMany;
    const filter = el('input', {
      type: 'checkbox',
      checked: !!field.filter,
      disabled: tooVaried && !field.filter,
      title: tooVaried ? 'Too many distinct values to filter by' : 'Offer this column on the filter bar',
    });
    filter.addEventListener('change', () => update({ filter: filter.checked }));

    const current = !field.editable ? 'readonly' : field.type === 'enum' ? 'enum' : 'text';
    const type = el('select', { className: 'type-pick' }, [
      el('option', { value: 'readonly', textContent: 'Read-only', selected: current === 'readonly' }),
      el('option', { value: 'text', textContent: 'Free text', selected: current === 'text' }),
      el('option', {
        value: 'enum',
        textContent: c.tooMany && current !== 'enum' ? 'Dropdown (too many values)' : 'Dropdown',
        selected: current === 'enum',
        disabled: c.tooMany && current !== 'enum',
      }),
    ]);
    // Switching to a dropdown seeds the choices from what is already in the column.
    type.addEventListener('change', () => {
      const values = type.value === 'enum' && !field.values.length ? c.distinct : field.values;
      update({
        editable: type.value !== 'readonly',
        type: type.value === 'enum' ? 'enum' : 'text',
        values,
        // Put a short new dropdown on the filter bar; never take one off.
        filter: field.filter || (type.value === 'enum' && values.length <= MAX_AUTO_FILTER),
      });
    });

    const rename = button('Rename', '', async () => {
      const to = prompt(`Rename "${c.name}" to`, c.name);
      if (!to || to === c.name) return;
      let result;
      try {
        result = await post(`/api/lists/${state.listId}/columns/rename`, { from: c.name, to });
      } catch (err) {
        return alert(err.message);
      }
      if (result.warnings?.length) alert(result.warnings.join('\n\n'));
      await renderColumnConfig();
    });

    const head = el('div', { className: 'col-head' }, [
      el('label', { className: 'inline' }, [show, document.createTextNode('Show')]),
      el('label', { className: 'inline' }, [filter, document.createTextNode('Filter')]),
      el('span', { className: 'col-name', textContent: c.name || '(unnamed column)' }),
      el('span', {
        className: 'muted small',
        textContent: c.imported
          ? `${c.distinct.length}${c.tooMany ? '+' : ''} distinct` + (c.blanks ? `, ${c.blanks} blank` : '')
          : 'added here',
      }),
      type,
      el('span', { className: 'reorder' }, [
        button('↑', '', () => move(c.name, -1)),
        button('↓', '', () => move(c.name, 1)),
      ]),
      rename,
      c.imported
        ? null
        : button('Remove', 'danger', () => {
            if (!confirm(`Remove the column "${c.name}" and every value in it?`)) return;
            const next = { ...all };
            delete next[c.name];
            saveSchema(next);
          }),
    ]);

    const isDropdown = field.editable && field.type === 'enum';
    return el(
      'div',
      { className: 'col-row' + (isDropdown ? ' open' : '') },
      isDropdown ? [head, ...valueEditor(c.name, field, all)] : [head]
    );
  });

  // --- add a column --------------------------------------------------------
  const newName = el('input', { type: 'text', placeholder: 'Column name' });
  const newType = el('select', {}, [
    el('option', { value: 'text', textContent: 'Free text' }),
    el('option', { value: 'enum', textContent: 'Dropdown' }),
  ]);
  const newValues = el('input', { type: 'text', placeholder: 'Choices, comma separated', hidden: true });
  newType.addEventListener('change', () => {
    newValues.hidden = newType.value !== 'enum';
  });
  const addColumn = () => {
    const name = newName.value.trim();
    if (!name) return;
    if (all[name]) return alert('This list already has a column with that name.');
    saveSchema({
      ...all,
      [name]: {
        editable: true,
        type: newType.value,
        values: newType.value === 'enum' ? newValues.value.split(',') : [],
        custom: true,
        show: true,
      },
    });
  };
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addColumn()));

  const anyWidth = Object.values(all).some((f) => f.width);
  // Which columns the LinkedIn lookup reads a person out of, changeable
  // here rather than only on first use.
  const liMap = state.list?.linkedin || {};
  const liLine = el('p', { className: 'muted small reset-widths' }, [
    document.createTextNode(
      liMap.nameColumn
        ? `LinkedIn lookups read the person from “${liMap.nameColumn}”` +
          (liMap.companyColumn ? ` and their firm from “${liMap.companyColumn}”. ` : '. ')
        : 'LinkedIn lookups do not know which column holds the person yet. '
    ),
    button(liMap.nameColumn ? 'Change' : 'Choose columns', '', () => {
      $('#columns-dialog').close();
      askColumnMapping(null);
    }),
  ]);
  if (liMap.nameColumn && !(state.investors.columns || []).includes(liMap.nameColumn)) {
    liLine.prepend(
      el('span', { className: 'muted small warn', textContent: `“${liMap.nameColumn}” no longer exists. ` })
    );
  }

  $('#column-config').replaceChildren(
    liLine,
    ...rows,
    anyWidth
      ? el('p', { className: 'muted small reset-widths' }, [
          document.createTextNode('Column widths are dragged from the table header. '),
          button('Reset all widths', '', () => {
            const next = {};
            for (const [name, f] of Object.entries(all)) next[name] = { ...f, width: null };
            saveSchema(next, order);
          }),
        ])
      : el('p', {
          className: 'muted small',
          textContent: 'Drag the right edge of a column header in the table to resize it; double-click it to reset.',
        }),
    el('h4', { className: 'section', textContent: 'Add a column' }),
    el('div', { className: 'add-column' }, [newName, newType, newValues, button('Add column', 'primary', addColumn)]),
    el('p', {
      className: 'muted small',
      textContent:
        'Show puts a column in the table; Filter puts it on the filter bar — filtering works on any column, it ' +
        'does not need to be editable. Imported columns are read-only until you make them editable; columns you ' +
        'add start editable. Only an editable column can be typed into or filled in by a playbook step.',
    })
  );
}

// ---------------------------------------------------------------------- run

async function run(body) {
  try {
    await post(`/api/lists/${state.listId}/run`, body);
    poll();
  } catch (err) {
    alert(err.message);
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The two knobs worth changing per run. They default to the saved settings,
 * remember what you last chose, and never write back to Settings.
 */
function runOptions(into) {
  const saved = state.settings || {};
  const conc = el('select', {}, [
    ...Array.from({ length: 8 }, (_, i) =>
      el('option', {
        value: String(i + 1),
        textContent: `${i + 1} at a time`,
        selected: String(i + 1) === String(state.runConcurrency ?? saved?.concurrency ?? 1),
      })
    ),
  ]);
  const eff = el('select', {}, [
    ...EFFORTS.map((e) =>
      el('option', {
        value: e,
        textContent: `${e} effort`,
        selected: e === (state.runEffort || saved?.effort || 'high'),
      })
    ),
  ]);

  into.replaceChildren(
    el('div', { className: 'run-options' }, [
      el('label', { className: 'inline' }, [document.createTextNode('Rows in parallel'), conc]),
      el('label', { className: 'inline' }, [document.createTextNode('Effort'), eff]),
    ]),
    el('p', {
      className: 'muted small',
      textContent:
        'Just for this run — Settings keeps its own values. More in parallel finishes sooner; lower effort is ' +
        'faster and cheaper per answer.',
    })
  );

  return () => {
    state.runConcurrency = Number(conc.value);
    state.runEffort = eff.value;
    return { concurrency: state.runConcurrency, effort: state.runEffort };
  };
}

/** What this list has cost per row so far, if it has been run. */
function perRowCost() {
  const done = state.cost?.byList.find((l) => l.id === state.listId);
  return done?.calls && state.investors.stepCount ? done.cost / (done.calls / state.investors.stepCount) : null;
}

/** Confirm a run, with the two runtime knobs and a projected bill. */
function askRun({ title, summary, rowCount, onStart }) {
  $('#run-dialog-title').textContent = title;
  $('#run-dialog-summary').textContent = summary;

  const per = perRowCost();
  $('#run-dialog-cost').textContent = per
    ? `Roughly ${money(per * rowCount)} at this list's average of ${money(per)} per row.`
    : 'No cost history for this list yet, so no estimate.';

  const read = runOptions($('#run-dialog-options'));
  const start = $('#run-dialog-start');
  start.onclick = (e) => {
    e.preventDefault();
    $('#run-dialog').close();
    onStart(read());
  };
  $('#run-dialog').showModal();
}

$('#run-all').addEventListener('click', () => {
  const target = runTarget();
  if (!target.rows.length) return;
  const what = target.selected ? 'selected' : isFiltered() ? 'filtered' : '';
  askRun({
    title: 'Run the playbook',
    summary: `${target.rows.length} ${what ? what + ' ' : ''}row(s) × ${state.investors.stepCount} step(s).`,
    rowCount: target.rows.length,
    // Send ids for anything but the whole list, so the server runs exactly this set.
    onStart: (opts) =>
      run(
        target.selected || isFiltered()
          ? { investorIds: target.rows.map((r) => r.__id), scopeLabel: what, ...opts }
          : { scope: 'all', ...opts }
      ),
  });
});

$('#fill-gaps').addEventListener('click', () => {
  const target = runTarget();
  const rows = target.rows.filter((r) => r.__done < state.investors.stepCount);
  if (!rows.length) return;
  const missingSteps = rows.reduce((n, r) => n + (state.investors.stepCount - r.__done), 0);
  const what = target.selected ? 'selected' : isFiltered() ? 'filtered' : '';
  askRun({
    title: 'Fill gaps',
    summary:
      `${missingSteps} missing step(s) across ${rows.length} ${what ? what + ' ' : ''}row(s). ` +
      'Steps that already have an answer are kept.',
    rowCount: rows.length,
    onStart: (opts) =>
      run(
        target.selected || isFiltered()
          ? { investorIds: rows.map((r) => r.__id), onlyMissing: true, scopeLabel: what, ...opts }
          : { scope: 'gaps', ...opts }
      ),
  });
});

$('#run-unanswered').addEventListener('click', () => {
  const target = runTarget();
  const rows = target.rows.filter((r) => r.__done < state.investors.stepCount);
  if (!rows.length) return;
  const what = target.selected ? 'selected' : isFiltered() ? 'filtered' : '';
  askRun({
    title: 'Re-run unanswered rows',
    summary:
      `The whole playbook again on ${rows.length} ${what ? what + ' ' : ''}row(s) missing any answer. ` +
      'Answers already there are replaced.',
    rowCount: rows.length,
    onStart: (opts) =>
      run(
        target.selected || isFiltered()
          ? { investorIds: rows.map((r) => r.__id), scopeLabel: what, ...opts }
          : { scope: 'unanswered', ...opts }
      ),
  });
});

// ------------------------------------------------- run a subset of steps

$('#run-steps').addEventListener('click', () => {
  const target = runTarget();
  if (!target.rows.length) return alert('No rows to run.');

  const steps = (state.playbook?.steps || []).filter((s) => s.enabled !== false);
  if (!steps.length) return alert('This list’s playbook has no enabled steps.');

  const scope = target.selected ? 'selected' : isFiltered() ? 'filtered' : '';
  $('#steps-target').textContent =
    `${target.rows.length} ${scope ? scope + ' row' : 'row'}${target.rows.length === 1 ? '' : 's'}` +
    '. Pick the steps to run; the answers they produce replace what is there.';

  // Default to whatever was picked last time, else everything.
  $('#step-picker').replaceChildren(
    ...steps.map((st) =>
      el('label', { className: 'step-pick' }, [
        el('input', {
          type: 'checkbox',
          value: st.id,
          checked: state.lastStepPick ? state.lastStepPick.includes(st.id) : true,
        }),
        el('span', { textContent: st.name }),
        st.writeTo ? el('span', { className: 'badge', textContent: `→ ${st.writeTo}` }) : null,
      ])
    )
  );
  state.readStepRunOptions = runOptions($('#steps-options'));
  $('#steps-dialog').showModal();
});

$('#steps-run').addEventListener('click', async (e) => {
  e.preventDefault();
  const stepIds = [...document.querySelectorAll('#step-picker input:checked')].map((i) => i.value);
  if (!stepIds.length) return alert('Pick at least one step.');
  state.lastStepPick = stepIds;

  const onlyMissing = $('#steps-only-missing').checked;
  const target = runTarget();
  let rows = target.rows;
  if (onlyMissing) {
    // Rows already holding every picked step have nothing to do.
    const answered = await Promise.all(
      rows.map(async (r) => {
        const d = await api(`/api/lists/${state.listId}/investors/${r.__id}`);
        return d.steps.every((st) => !stepIds.includes(st.id) || st.answer?.text);
      })
    );
    rows = rows.filter((_, i) => !answered[i]);
    if (!rows.length) {
      $('#steps-dialog').close();
      return alert('Every one of those rows already has an answer for the steps you picked.');
    }
  }

  const opts = state.readStepRunOptions ? state.readStepRunOptions() : {};
  if (!confirm(`Run ${stepIds.length} step(s) on ${rows.length} row(s)?`)) return;
  $('#steps-dialog').close();
  run({
    investorIds: rows.map((r) => r.__id),
    stepIds,
    onlyMissing,
    scopeLabel: target.selected ? 'selected' : isFiltered() ? 'filtered' : '',
    ...opts,
  });
});

$('#clear-selection').addEventListener('click', () => {
  state.selection = new Set();
  state.anchor = null;
  renderTable();
});
$('#cancel').addEventListener('click', () => post('/api/run/cancel'));

let polling = false;
let wasRunning = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const s = await api('/api/run/status');
    const pill = $('#runpill');
    $('#cancel').disabled = !s.running;

    const before = [...state.job.current].join(',');
    state.job = {
      listId: s.running ? s.listId : null,
      current: new Set(s.running ? s.currentIds || [] : []),
      pending: new Set(s.running ? s.pendingIds || [] : []),
    };
    const changed = before !== [...state.job.current].join(',');

    if (state.running !== !!s.running) {
      state.running = !!s.running;
      renderRunButtons(visibleRows());
      renderTable();
    } else if (changed && s.listId === state.listId) {
      renderTable();
    }

    if (s.running) {
      pill.className = 'pill running';
      pill.textContent =
        `${s.listName}: ${s.completed}/${s.total} · ${money(s.cost || 0)}` +
        (s.etaMs ? ` · ~${humanMs(s.etaMs)} left` : '') +
        ' · ' +
        (s.current?.join(', ') || 'working…');
      pill.title = s.avgMs ? `Averaging ${humanMs(s.avgMs)} per investor` : '';
    } else if (s.status) {
      pill.className = 'pill done';
      pill.textContent =
        `${s.status} — ${s.completed}/${s.total}, ${money(s.cost || 0)}` +
        (s.avgMs ? `, ${humanMs(s.avgMs)}/investor` : '') +
        (s.stepErrors ? `, ${s.stepErrors} step error${s.stepErrors === 1 ? '' : 's'}` : '');
      pill.title = '';
    } else {
      pill.className = 'pill idle';
      pill.textContent = 'Idle';
    }

    if (s.log) {
      const log = $('#log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(
        ...s.log.map((l) =>
          el('div', { textContent: `${clock(l.t)}  ${l.msg}`, title: new Date(l.t).toLocaleString() })
        )
      );
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    // Refresh whatever is on screen while a run touches this list.
    if ((s.running || wasRunning) && s.listId) {
      await loadCost();
      if (s.listId === state.listId) {
        await loadInvestors();
        if (state.selected && !editorFocused()) await selectInvestor(state.selected);
      } else if (parseHash().view === 'lists') {
        await loadLists();
      }
    }
    wasRunning = !!s.running;
  } catch {
    /* server restarting; next tick retries */
  } finally {
    polling = false;
  }
}

setInterval(poll, 2000);

// ----------------------------------------------------------------- playbook

async function loadPlaybook() {
  state.playbook = await api(`/api/lists/${state.listId}/playbook`);
  $('#system').value = state.playbook.system || '';
  $('#mode').value = state.playbook.mode || 'conversation';
  renderSteps();
}

let activePrompt = null;

/** Which column this step's answer should fill in, if any. */
function writeToSelect(step) {
  const sel = el('select', { className: 'writeto' }, [
    el('option', { value: '', textContent: '— none —', selected: !step.writeTo }),
    ...editableColumns().map((name) =>
      el('option', {
        value: name,
        textContent: `${name} (${fieldFor(name)?.type === 'enum' ? 'dropdown' : 'text'})`,
        selected: name === step.writeTo,
      })
    ),
  ]);
  if (step.writeTo && !editableColumns().includes(step.writeTo)) {
    sel.append(
      el('option', {
        value: step.writeTo,
        textContent: `${step.writeTo} (${fieldFor(step.writeTo) ? 'read-only' : 'missing'})`,
        selected: true,
      })
    );
  }
  sel.addEventListener('change', () => {
    step.writeTo = sel.value;
  });
  return sel;
}

function renderSteps() {
  if (!state.playbook?.id) {
    $('#steps').replaceChildren(
      el('p', {
        className: 'muted',
        textContent: 'No playbook attached to this list. Pick a saved one above, or create one with “Save as new…”.',
      })
    );
    return;
  }
  $('#steps').replaceChildren(
    ...state.playbook.steps.map((s, i) => {
      const node = el('div', { className: 'step' + (s.enabled === false ? ' disabled' : '') });
      const name = el('input', { type: 'text', value: s.name, placeholder: 'Step name' });
      name.addEventListener('input', () => {
        s.name = name.value;
      });

      const prompt = el('textarea', {
        rows: 5,
        value: s.prompt,
        placeholder: 'Ask the LLM… use {{Column Name}} to insert values from this list',
      });
      prompt.addEventListener('input', () => {
        s.prompt = prompt.value;
        preview(prompt.value);
      });
      prompt.addEventListener('focus', () => {
        activePrompt = prompt;
        preview(prompt.value);
      });

      const web = el('input', { type: 'checkbox', checked: !!s.webSearch });
      web.addEventListener('change', () => {
        s.webSearch = web.checked;
      });
      const on = el('input', { type: 'checkbox', checked: s.enabled !== false });
      on.addEventListener('change', () => {
        s.enabled = on.checked;
        node.classList.toggle('disabled', !on.checked);
      });

      node.append(
        el('div', { className: 'step-head' }, [
          el('span', { className: 'num', textContent: String(i + 1) }),
          name,
          button('↑', '', () => move(i, -1)),
          button('↓', '', () => move(i, 1)),
          button('Delete', 'danger', () => {
            state.playbook.steps.splice(i, 1);
            renderSteps();
          }),
        ]),
        prompt,
        el('div', { className: 'step-opts' }, [
          el('label', {}, [web, document.createTextNode('Let the model search the web')]),
          el('label', {}, [on, document.createTextNode('Enabled')]),
          el('label', {}, [document.createTextNode('Fill column'), writeToSelect(s)]),
          el('span', { textContent: `reference later as {{steps.${slug(s.key || s.name)}}}` }),
        ])
      );
      return node;
    })
  );
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.playbook.steps.length) return;
  const [s] = state.playbook.steps.splice(i, 1);
  state.playbook.steps.splice(j, 0, s);
  renderSteps();
}

function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'step';
}

$('#add-step').addEventListener('click', () => {
  if (!state.playbook?.id) return alert('Attach or create a playbook first.');
  state.playbook.steps.push({
    name: `Step ${state.playbook.steps.length + 1}`,
    prompt: '',
    webSearch: true,
    enabled: true,
  });
  renderSteps();
});

$('#save-playbook').addEventListener('click', async () => {
  if (!state.playbook?.id) {
    return alert('Attach a playbook first, or use “Save as new…” to create one.');
  }
  state.playbook.system = $('#system').value;
  state.playbook.mode = $('#mode').value;
  try {
    state.playbook = await api(`/api/lists/${state.listId}/playbook`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.playbook),
    });
  } catch (err) {
    return alert(err.message);
  }
  renderSteps();
  renderTokens();
  await fillPlaybookPicker();
  $('#playbook-status').textContent = `Saved “${state.playbook.name}” at ` + new Date().toLocaleTimeString();
  await loadInvestors();
});

async function fillPlaybookPicker() {
  state.playbooks = await api('/api/playbooks');
  const sel = $('#playbook-pick');
  sel.replaceChildren(
    el('option', { value: '', textContent: '— none —', selected: !state.playbook?.id }),
    ...state.playbooks.map((p) =>
      el('option', {
        value: p.id,
        textContent: `${p.name} (${p.stepCount} step${p.stepCount === 1 ? '' : 's'})`,
        selected: p.id === state.playbook?.id,
      })
    )
  );

  // Warn when editing here changes another list's playbook too.
  const mine = state.playbooks.find((p) => p.id === state.playbook?.id);
  const others = (mine?.usedBy || []).filter((l) => l.id !== state.listId);
  const notice = $('#playbook-shared');
  notice.classList.toggle('hidden', !others.length);
  notice.textContent = others.length
    ? `Also used by ${others.map((l) => l.name).join(', ')} — edits here apply there too. Use “Save as new…” to branch off instead.`
    : '';
}

async function attachPlaybook(playbookId) {
  state.playbook = await post(`/api/lists/${state.listId}/playbook/attach`, { playbookId });
  $('#system').value = state.playbook.system || '';
  $('#mode').value = state.playbook.mode || 'conversation';
  renderSteps();
  renderTokens();
  await fillPlaybookPicker();
  await loadInvestors();
}

$('#playbook-pick').addEventListener('change', (e) => attachPlaybook(e.target.value || null));

$('#fork-playbook').addEventListener('click', async () => {
  const name = prompt('Name for the new playbook', `${state.playbook?.name || 'Playbook'} (copy)`);
  if (!name) return;
  // Fork whatever is on screen, including unsaved edits.
  state.playbook = await post('/api/playbooks', {
    name,
    system: $('#system').value,
    mode: $('#mode').value,
    steps: state.playbook?.steps || [],
    attachTo: state.listId,
  });
  renderSteps();
  renderTokens();
  await fillPlaybookPicker();
  await loadInvestors();
  $('#playbook-status').textContent = 'Saved as “' + name + '”';
});

// ------------------------------------------------------- playbooks index

async function loadPlaybookIndex() {
  state.playbooks = await api('/api/playbooks');
  const grid = $('#playbook-grid');

  if (!state.playbooks.length) {
    grid.replaceChildren(
      el('p', { className: 'muted', textContent: 'No playbooks yet. Create one here, or from a list’s Playbook tab.' })
    );
    return;
  }

  grid.replaceChildren(
    ...state.playbooks.map((p) =>
      el('div', { className: 'card' }, [
        el('h3', { textContent: p.name }),
        el('div', {
          className: 'muted small',
          textContent:
            `${p.stepCount} step${p.stepCount === 1 ? '' : 's'} · ` +
            (p.mode === 'independent' ? 'independent steps' : 'one conversation'),
        }),
        el('div', { className: 'muted small' }, [
          p.usedBy.length
            ? el('span', {}, [
                document.createTextNode('Used by '),
                ...p.usedBy.map((l, i) =>
                  el('span', {}, [
                    i ? document.createTextNode(', ') : null,
                    el('a', { href: `#/list/${l.id}/playbook`, textContent: l.name }),
                  ])
                ),
              ])
            : el('span', { textContent: 'Not attached to any list' }),
        ]),
        el('div', { className: 'card-actions' }, [
          ...(p.usedBy.length
            ? [el('a', { className: 'btn primary', href: `#/list/${p.usedBy[0].id}/playbook`, textContent: 'Edit' })]
            : []),
          button('Duplicate', '', async () => {
            const name = prompt('Name for the copy', `${p.name} (copy)`);
            if (!name) return;
            await post('/api/playbooks', { name, copyFrom: p.id });
            loadPlaybookIndex();
          }),
          button('Rename', '', async () => {
            const name = prompt('Playbook name', p.name);
            if (!name) return;
            const full = await api(`/api/playbooks/${p.id}`);
            await api(`/api/playbooks/${p.id}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...full, name }),
            });
            loadPlaybookIndex();
          }),
          button('Delete', 'danger', async () => {
            if (!confirm(`Delete the playbook "${p.name}"?`)) return;
            try {
              await api(`/api/playbooks/${p.id}`, { method: 'DELETE' });
            } catch (err) {
              return alert(err.message);
            }
            loadPlaybookIndex();
          }),
        ]),
      ])
    )
  );
}

$('#new-playbook').addEventListener('click', async () => {
  const name = prompt('Name the playbook', 'New playbook');
  if (!name) return;
  await post('/api/playbooks', { name });
  loadPlaybookIndex();
});

function renderTokens() {
  const tokens = state.investors.columns.map((c) => `{{${c}}}`);
  for (const s of state.playbook?.steps || []) tokens.push(`{{steps.${slug(s.key || s.name)}}}`);
  $('#tokens').replaceChildren(
    ...tokens.map((t) => {
      const b = el('span', { className: 'token', textContent: t });
      b.addEventListener('click', () => {
        if (activePrompt) {
          const p = activePrompt.selectionStart ?? activePrompt.value.length;
          activePrompt.value = activePrompt.value.slice(0, p) + t + activePrompt.value.slice(p);
          activePrompt.dispatchEvent(new Event('input'));
          activePrompt.focus();
          activePrompt.selectionStart = activePrompt.selectionEnd = p + t.length;
        } else {
          navigator.clipboard?.writeText(t);
        }
      });
      return b;
    })
  );
}

let previewTimer;
function preview(tpl) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await post(`/api/lists/${state.listId}/playbook/preview`, {
        prompt: tpl,
        investorId: state.selected,
      });
      $('#preview').textContent =
        r.text + (r.missing.length ? `\n\n⚠ unknown variables: ${[...new Set(r.missing)].join(', ')}` : '');
    } catch (err) {
      $('#preview').textContent = err.message;
    }
  }, 250);
}

// ----------------------------------------------------------------- settings

async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  $('#model').value = s.model;
  $('#effort').value = s.effort;
  $('#maxTokens').value = s.maxTokens;
  $('#concurrency').value = s.concurrency;
  $('#keyhint').textContent = s.apiKeySet
    ? `— a key ending ${s.apiKeyHint} is stored; leave blank to keep it`
    : '— not set';
}

$('#save-settings').addEventListener('click', async () => {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiKey: $('#apiKey').value,
      model: $('#model').value,
      effort: $('#effort').value,
      maxTokens: $('#maxTokens').value,
      concurrency: $('#concurrency').value,
    }),
  });
  $('#apiKey').value = '';
  $('#settings-status').textContent = 'Saved.';
  loadSettings();
});

$('#clear-key').addEventListener('click', async () => {
  if (!confirm('Remove the stored API key?')) return;
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clearApiKey: true }),
  });
  $('#settings-status').textContent = 'Key cleared.';
  loadSettings();
});



// ------------------------------------- queueing a row for a LinkedIn lookup

// Guesses for which column holds a person and which holds their firm, so the
// one-time mapping dialog usually just needs confirming.
const PERSON_HINTS = ['main investor', 'contact', 'partner', 'person', 'name', 'who', 'lead partner'];
const COMPANY_HINTS = ['lead investor', 'company', 'firm', 'investor', 'organization', 'organisation'];

const guessColumn = (columns, hints) =>
  columns.find((c) => hints.some((h) => c.toLowerCase().trim() === h)) ||
  columns.find((c) => hints.some((h) => c.toLowerCase().includes(h))) ||
  '';

/** The saved mapping, but only while the columns it names still exist. */
function linkedinMapping() {
  const map = state.list?.linkedin;
  if (!map?.nameColumn) return null;
  const columns = state.investors.columns || [];
  if (!columns.includes(map.nameColumn)) return null; // renamed or removed
  return {
    nameColumn: map.nameColumn,
    companyColumn: columns.includes(map.companyColumn) ? map.companyColumn : '',
  };
}

/** Queue one row's person for a LinkedIn path lookup. */
async function findPathForRow(row) {
  const map = linkedinMapping();
  if (!map) return askColumnMapping(row);
  await queueRowLookups([row], map);
}

async function queueRowLookups(rows, map) {
  const people = rows
    .map((r) => ({
      name: String(r[map.nameColumn] ?? '').trim(),
      company: String(map.companyColumn ? r[map.companyColumn] ?? '' : '').trim(),
    }))
    .filter((p) => p.name);

  if (!people.length) {
    return toast(
      `No name in “${map.nameColumn}” for ${rows.length === 1 ? 'that row' : 'any of those rows'}.`,
      'bad'
    );
  }

  try {
    await post('/api/linkedin/lookup', { people });
  } catch (err) {
    return toast(err.message, 'bad');
  }

  // Stay where you are; the Connection column fills itself in as it runs.
  const who = people.length === 1 ? people[0].name : `${people.length} people`;
  toast(`${who} queued — the Connection column will update as it runs`, 'good');
  await refreshConnections();
}

/** Re-read the LinkedIn contacts and repaint the rows that show them. */
async function refreshConnections() {
  if (!state.listId) return;
  await loadLinkedInIndex();
  if (parseHash().view === 'investors') renderTable();
}

/** Asked once per list; the answer is saved on the list. */
function askColumnMapping(rowToQueueAfter) {
  const columns = state.investors.columns || [];
  const saved = state.list?.linkedin || {};
  const fill = (sel, guess, blank) =>
    sel.replaceChildren(
      el('option', { value: '', textContent: blank }),
      ...columns.map((c) =>
        el('option', { value: c, textContent: c || '(unnamed)', selected: c === guess })
      )
    );

  // Start from what is set, if those columns still exist; otherwise guess.
  const keep = (c) => (columns.includes(c) ? c : '');
  fill($('#li-map-name'), keep(saved.nameColumn) || guessColumn(columns, PERSON_HINTS), '— choose —');
  fill($('#li-map-company'), keep(saved.companyColumn) || guessColumn(columns, COMPANY_HINTS), '— none —');

  $('#li-map-save').onclick = async (e) => {
    e.preventDefault();
    const nameColumn = $('#li-map-name').value;
    if (!nameColumn) return alert('Pick the column holding the person’s name.');
    const companyColumn = $('#li-map-company').value;

    const updated = await api(`/api/lists/${state.listId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkedin: { nameColumn, companyColumn } }),
    });
    state.list = { ...state.list, linkedin: updated.linkedin };
    $('#li-map-dialog').close();
    if (rowToQueueAfter) await queueRowLookups([].concat(rowToQueueAfter), updated.linkedin);
  };

  $('#li-map-dialog').showModal();
}

$('#find-paths').addEventListener('click', () => {
  const target = runTarget();
  if (!target.rows.length) return;
  const map = linkedinMapping();
  if (!map) return askColumnMapping(target.rows);
  queueRowLookups(target.rows, map);
});

// =========================================================== LinkedIn agent
// Finds the warmest path to a person: who they are on LinkedIn, how far away
// they are, and — for a 2nd-degree contact — who you both know.

const li = {
  contacts: [],
  selected: null,
  filter: '',
  last: null, // the person searched for most recently
  network: [], // who is already in My network, to avoid re-adding them
  picked: new Set(), // contacts ticked for deletion
  session: { open: false, loggedIn: false },
};

const DEGREE_LABEL = { '1st': 'You know them', '2nd': 'One hop away', '3rd': 'Three degrees out' };

/** Matches the key the network store dedupes on, so the counts agree. */
const networkKey = (p) => String(p.url || `name:${p.name}`).toLowerCase().replace(/\/+$/, '');
const inNetwork = (p) => li.networkKeys?.has(networkKey(p));

/** People from `via` who are not in the network yet. */
const notYetInNetwork = (via) => (via || []).filter((p) => !inNetwork(p));

async function loadNetworkKeys() {
  try {
    li.network = await api('/api/linkedin/network');
  } catch {
    return;
  }
  li.networkKeys = new Set(li.network.map(networkKey));
  li.networkBy = new Map(li.network.map((p) => [networkKey(p), p]));
}

/** What your network already records about this person, if anything. */
const networkEntry = (p) => li.networkBy?.get(networkKey(p)) || null;

/**
 * Best path first: by the rank you gave them, then by how well you know
 * them. Anyone not in your network yet sorts to the end — they have neither.
 */
function byRankThenStrength(a, b) {
  const A = networkEntry(a);
  const B = networkEntry(b);
  const ar = A?.rank ?? Infinity;
  const br = B?.rank ?? Infinity;
  if (ar !== br) return ar - br;
  const as = A?.strength ?? -1;
  const bs = B?.strength ?? -1;
  if (as !== bs) return bs - as;
  return String(a.name).localeCompare(String(b.name));
}

async function liSession(action) {
  try {
    li.session = await (action ? post(`/api/linkedin/session/${action}`) : api('/api/linkedin/session'));
  } catch (err) {
    li.session = { open: false, loggedIn: false, error: err.message };
  }
  renderLiSession();
  return li.session;
}

function renderLiSession() {
  const s = li.session;
  const pill = $('#li-state');
  pill.className = 'pill ' + (s.loggedIn ? 'done' : s.open ? 'running' : 'idle');
  pill.textContent = s.error
    ? s.error
    : !s.open
    ? 'Not running'
    : s.loggedIn
    ? 'Signed in'
    : 'Waiting for you to sign in…';
  $('#li-stop').disabled = !s.open;
  $('#li-start').textContent = s.open ? 'Bring window forward' : 'Start agent session';
  // Detection can be wrong; let the person settle it.
  $('#li-recheck').classList.toggle('hidden', !s.open || s.loggedIn);
  if (s.detectedBy) pill.title = `Signed-in state read from the ${s.detectedBy}`;
  // The lookup row stays usable with no session: names can be queued first
  // and the agent picks them up as soon as it is signed in.
  $('#li-hint').textContent = s.loggedIn
    ? ''
    : s.open
    ? 'Sign in to LinkedIn in the agent window; queued lookups carry on by themselves.'
    : 'Queue a name and the agent window opens by itself.';
}

$('#li-start').addEventListener('click', async () => {
  $('#li-start').disabled = true;
  try {
    await liSession('start');
    if (li.session.open && !li.session.loggedIn) {
      // The browser is open on the login page; wait for the person to finish.
      await liSession('wait-login');
    }
    if (li.session.loggedIn) {
      await post('/api/linkedin/queue/resume').catch(() => {});
      pollLinkedIn();
    }
  } finally {
    $('#li-start').disabled = false;
  }
});

$('#li-recheck').addEventListener('click', async () => {
  const b = $('#li-recheck');
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    await liSession('recheck');
    if (!li.session.loggedIn) {
      alert(
        'Still not seeing a signed-in LinkedIn session in that window.\n\n' +
          'Make sure the agent window itself (not another Chrome window) is signed in, ' +
          'then try again.'
      );
    } else {
      pollLinkedIn();
    }
  } finally {
    b.disabled = false;
    b.textContent = "I'm already signed in";
  }
});

// Whatever is in flight finishes; this drops what has not started, and puts
// the rows it was going to fill back the way it found them.
$('#li-clear-queue').addEventListener('click', async () => {
  let r;
  try {
    r = await post('/api/linkedin/queue/clear');
  } catch (err) {
    return toast(err.message, 'bad');
  }
  toast(r.dropped ? `${r.dropped} dropped from the queue` : 'Nothing was waiting');
  pollLinkedIn();
});

$('#li-stop').addEventListener('click', () => liSession('stop'));

async function queueLookup(people) {
  // The agent opens its own window if it has to — queueing is the instruction.
  await post('/api/linkedin/lookup', Array.isArray(people) ? { people } : people);
  await pollLinkedIn();
}

$('#li-add').addEventListener('click', async () => {
  const name = $('#li-name').value.trim();
  if (!name) return $('#li-name').focus();
  try {
    await queueLookup({ name, company: $('#li-company').value.trim() });
    $('#li-name').value = '';
    $('#li-company').value = '';
    $('#li-name').focus();
  } catch (err) {
    alert(err.message);
  }
});

// Enter in either field queues the lookup.
for (const id of ['#li-name', '#li-company']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#li-add').click();
    }
  });
}

$('#li-from-list').addEventListener('click', async () => {
  const listId = $('#li-list').value;
  const nameColumn = $('#li-name-col').value;
  if (!listId || !nameColumn) return alert('Pick a list and the column holding the person’s name.');
  try {
    const r = await post('/api/linkedin/lookup-from-list', {
      listId,
      nameColumn,
      companyColumn: $('#li-company-col').value,
    });
    alert(`Queued ${r.queued} lookup(s).${r.skipped ? ` ${r.skipped} skipped — already looked up or blank.` : ''}`);
    pollLinkedIn();
  } catch (err) {
    alert(err.message);
  }
});

$('#li-again').addEventListener('click', async () => {
  if (!li.last) return;
  try {
    await queueLookup({ name: li.last.name, company: li.last.company });
  } catch (err) {
    alert(err.message);
  }
});

$('#li-search').addEventListener('input', (e) => {
  li.filter = e.target.value;
  renderLiTable();
});

/** Lists and their columns, for queueing names straight out of a list. */
async function fillLiListPickers() {
  const lists = await api('/api/lists');
  const sel = $('#li-list');
  const keep = sel.value;
  sel.replaceChildren(
    el('option', { value: '', textContent: '— choose —' }),
    ...lists.map((l) => el('option', { value: l.id, textContent: l.name, selected: l.id === keep }))
  );
  await fillLiColumnPickers();
}

async function fillLiColumnPickers() {
  const listId = $('#li-list').value;
  const name = $('#li-name-col');
  const company = $('#li-company-col');
  if (!listId) {
    name.replaceChildren(el('option', { value: '', textContent: 'name column' }));
    company.replaceChildren(el('option', { value: '', textContent: 'company column' }));
    return;
  }
  const { columns, list } = await api(`/api/lists/${listId}/investors`);
  // Default to the mapping the list already remembers, if there is one.
  const saved = list?.linkedin || {};
  const opts = (blank, chosen) => [
    el('option', { value: '', textContent: blank }),
    ...columns.map((c) => el('option', { value: c, textContent: c || '(unnamed)', selected: c === chosen })),
  ];
  name.replaceChildren(...opts('name column', saved.nameColumn));
  company.replaceChildren(...opts('company column', saved.companyColumn));
}

$('#li-list').addEventListener('change', fillLiColumnPickers);

async function loadContacts() {
  li.contacts = await api('/api/linkedin/contacts');
  renderLiTable();
}

function liVisible() {
  const q = li.filter.trim().toLowerCase();
  if (!q) return li.contacts;
  return li.contacts.filter((c) =>
    [c.name, c.company, c.headline, c.degree].some((v) => String(v ?? '').toLowerCase().includes(q))
  );
}

/**
 * How many of this contact's mutual connections you have not added yet —
 * what "Add N new to my network" would take.
 */
function missingCell(c) {
  if (!c.via?.length) return el('span', { className: 'muted', textContent: '—' });
  const n = notYetInNetwork(c.via).length;
  return el('span', {
    className: 'missing' + (n ? '' : ' none'),
    textContent: n ? `${n} of ${c.via.length}` : 'all added',
    title: n
      ? `${n} of ${c.via.length} mutual connections are not in your network yet`
      : 'Every mutual connection is already in your network',
  });
}

/** Today shows the clock; anything older shows the date too. */
function lookupTime(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderLiTable() {
  const rows = liVisible();
  const allTicked = rows.length > 0 && rows.every((c) => li.picked.has(c.id));
  const someTicked = !allTicked && rows.some((c) => li.picked.has(c.id));
  const tickAll = el('input', { type: 'checkbox', checked: allTicked, title: 'Select all shown' });
  tickAll.indeterminate = someTicked;
  tickAll.addEventListener('change', () => {
    for (const c of rows) (tickAll.checked ? li.picked.add(c.id) : li.picked.delete(c.id));
    renderLiTable();
  });

  $('#li-table thead').replaceChildren(
    el('tr', {}, [
      el('th', { className: 'tick' }, tickAll),
      el('th', { textContent: 'Person' }),
      el('th', { textContent: 'Company' }),
      el('th', { textContent: 'Connection' }),
      el('th', { textContent: 'Via' }),
      el('th', { textContent: 'Not in network' }),
      el('th', { textContent: 'Strength' }),
      el('th', { textContent: 'Lookup time' }),
    ])
  );

  const pickedContacts = li.contacts.filter((c) => li.picked.has(c.id));
  const picked = pickedContacts.length;
  // Count only the people who are not in the network yet — adding the rest
  // would just re-record paths already known.
  const fresh = new Set();
  for (const c of pickedContacts) for (const p of notYetInNetwork(c.via)) fresh.add(networkKey(p));
  const mutuals = fresh.size;

  $('#li-add-mutuals').classList.toggle('hidden', !mutuals);
  $('#li-add-mutuals').textContent = `Add ${mutuals} new mutual connection${mutuals === 1 ? '' : 's'} to my network`;

  $('#li-delete').classList.toggle('hidden', !picked);
  $('#li-delete').textContent = `Delete ${picked} selected`;
  $('#li-clear-all').disabled = !li.contacts.length;

  $('#li-table tbody').replaceChildren(
    ...rows.map((c) => {
      const working = c.status === 'running' || c.status === 'queued';
      const degree = working
        ? el('span', { className: 'badge running', title: c.stage || 'Queued' }, [
            c.status === 'running' ? el('i', { className: 'spinner' }) : null,
            document.createTextNode(c.status === 'running' ? 'working' : 'queued'),
          ])
        : c.degree
        ? el('span', { className: `badge deg-${c.degree}`, textContent: c.degree, title: DEGREE_LABEL[c.degree] || '' })
        : el('span', {
            className: 'badge err',
            textContent: c.status === 'failed' ? 'failed' : c.status === 'not found' ? 'not found' : '—',
            title: c.reason || '',
          });

      const strength = el('select', { className: 'cell-select' }, [
        el('option', { value: '', textContent: '—', selected: !c.strength }),
        ...Array.from({ length: 10 }, (_, i) =>
          el('option', { value: String(i + 1), textContent: String(i + 1), selected: c.strength === i + 1 })
        ),
      ]);
      strength.addEventListener('click', (e) => e.stopPropagation());
      strength.addEventListener('change', async () => {
        await api(`/api/linkedin/contacts/${c.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ strength: strength.value }),
        });
        c.strength = strength.value ? Number(strength.value) : null;
      });

      const tick = el('input', { type: 'checkbox', checked: li.picked.has(c.id) });
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        tick.checked ? li.picked.add(c.id) : li.picked.delete(c.id);
        renderLiTable();
      });

      const when = c.ranAt || c.updatedAt;
      const tr = el('tr', {
        className:
          (c.id === li.selected ? 'selected ' : '') +
          (li.picked.has(c.id) ? 'ticked ' : '') +
          (working ? 'active' : ''),
      }, [
        el('td', { className: 'tick' }, tick),
        el('td', { textContent: c.name, title: c.headline || '' }),
        el('td', { textContent: c.company || '', title: c.company || '' }),
        el('td', {}, degree),
        el('td', { textContent: c.via?.length ? String(c.via.length) : '' }),
        el('td', {}, missingCell(c)),
        el('td', {}, strength),
        el('td', {
          className: 'when',
          textContent: when ? lookupTime(when) : '',
          title: when
            ? new Date(when).toLocaleString() + (c.tookMs ? ` · took ${(c.tookMs / 1000).toFixed(1)}s` : '')
            : '',
        }),
      ]);
      tr.addEventListener('click', () => selectContact(c.id));
      return tr;
    })
  );
}

/**
 * Add everyone a set of contacts is connected through. Each person keeps the
 * contact they are a path to, so someone reachable via two investors records
 * both.
 */
async function addPeople(groups) {
  const live = groups.filter((g) => g.people.length);
  if (!live.length) return toast('Everyone there is already in your network.');

  let r;
  try {
    r = await post('/api/linkedin/network', {
      groups: live.map((g) => ({
        source: g.source,
        people: g.people.map((p) => ({ name: p.name, url: p.url, headline: p.headline, photo: p.photo })),
      })),
    });
  } catch (err) {
    return toast(err.message, 'bad');
  }

  await loadNetworkKeys();
  const bits = [r.added ? `${r.added} added to your network` : '', r.merged ? `${r.merged} already there` : ''];
  toast(bits.filter(Boolean).join(' · ') || 'Nothing to add', 'good');
}

/**
 * Add everyone a set of contacts is connected through who is not already in
 * the network. Each person keeps the contact they are a path to, so someone
 * reachable via two investors records both.
 */
async function addMutualsFrom(contacts) {
  const groups = contacts
    .map((c) => ({ source: { id: c.id, name: c.name }, people: notYetInNetwork(c.via) }))
    .filter((g) => g.people.length);

  if (!groups.length) {
    return toast('Nothing new — everyone they are connected through is already in your network.');
  }
  await addPeople(groups);
}

/**
 * The mutual connections, tickable, with the one action worth taking on
 * them: adding them to the people you know.
 */
function mutualPicker(contact) {
  const chosen = new Map();
  const wrap = el('div', { className: 'picker' });

  const addBtn = button('Add to my network', 'primary', async () => {
    const people = [...chosen.values()];
    if (!people.length) return;
    await addPeople([{ source: { id: contact.id, name: contact.name }, people }]);
    chosen.clear();
    selectContact(contact.id);
  });

  const missing = notYetInNetwork(contact.via);
  const already = contact.via.length - missing.length;

  const addAll = button(`Add ${missing.length} new to my network`, '', async () => {
    await addPeople([{ source: { id: contact.id, name: contact.name }, people: missing }]);
    await loadNetworkKeys();
    selectContact(contact.id);
  });
  addAll.disabled = !missing.length;

  const all = el('label', { className: 'inline' }, [
    (() => {
      const box = el('input', { type: 'checkbox' });
      box.addEventListener('change', () => {
        for (const cb of wrap.querySelectorAll('.person-tick')) {
          if (cb.checked !== box.checked) cb.click();
        }
      });
      return box;
    })(),
    document.createTextNode('Select all'),
  ]);

  const count = el('span', { className: 'muted small' });
  const sync = () => {
    count.textContent = chosen.size ? `${chosen.size} selected` : '';
    addBtn.disabled = !chosen.size;
  };

  wrap.append(
    el('div', { className: 'picker-bar' }, [
      all,
      count,
      addBtn,
      addAll,
      el('span', {
        className: 'muted small',
        textContent: missing.length
          ? `${missing.length} of ${contact.via.length} not in your network yet` +
            (already ? ` · ${already} already there` : '')
          : 'All of them are already in your network',
      }),
    ]),
    el(
      'div',
      { className: 'people' },
      [...contact.via].sort(byRankThenStrength).map((v) =>
        personCard(
          v,
          (person, on) => {
            on ? chosen.set(person.url || person.name, person) : chosen.delete(person.url || person.name);
            sync();
          },
          true
        )
      )
    )
  );
  sync();
  return wrap;
}

/** Forget a set of lookups, and everything cached for them. */
async function deleteContacts(ids, { all: everything } = {}) {
  try {
    await post('/api/linkedin/contacts/delete', everything ? { all: true } : { ids });
  } catch (err) {
    return alert(err.message);
  }
  for (const id of ids) li.picked.delete(id);
  if (everything) li.picked.clear();
  if (!li.contacts.some((c) => c.id === li.selected) || everything || ids.includes(li.selected)) {
    li.selected = null;
    $('#li-detail').replaceChildren(
      el('p', { className: 'muted pad', textContent: 'Select a contact to see the path to them.' })
    );
  }
  await loadContacts();
}

$('#li-delete').addEventListener('click', () => {
  const ids = [...li.picked];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} lookup${ids.length === 1 ? '' : 's'}? The pages cached for them go too.`)) return;
  deleteContacts(ids);
});

$('#li-clear-all').addEventListener('click', () => {
  const n = li.contacts.length;
  if (!n) return alert('There are no lookups to delete.');
  if (!confirm(`Delete all ${n} lookup${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
  deleteContacts([], { all: true });
});

/**
 * The degree the accepted search result carried. LinkedIn states it on the
 * result card, and that card is kept — so when the profile page yields
 * nothing, the answer is usually already on record.
 */
/** Record a search result as the right person, then go and read them. */
async function acceptCandidate(contact, pick) {
  const pct = Math.round((pick.confidence ?? 0) * 100);
  if (
    !confirm(
      `Record ${pick.name} as ${contact.queriedAs || contact.name}?` +
        `\n\nIt scored ${pct}%, below the 90% bar. Their profile will then be opened, ` +
        'which reads the connection degree and follows the mutual connections.'
    )
  ) {
    return;
  }
  try {
    await post(`/api/linkedin/contacts/${contact.id}/accept`, { url: pick.url });
  } catch (err) {
    return toast(err.message, 'bad');
  }
  toast(`Accepted ${pick.name} — reading their profile now`, 'good');
  await pollLinkedIn();
}

function searchDegree(c) {
  const accepted = (c.candidates || []).find((x) => (x.confidence ?? 0) >= 0.9 && x.degree);
  return accepted?.degree || null;
}

function selectContact(id) {
  li.selected = id;
  renderLiTable();
  const c = li.contacts.find((x) => x.id === id);
  if (!c) return;

  const busy = c.status === 'running' || c.status === 'queued';
  const parts = [
    el('div', { className: 'detail-head' }, [
      el('h2', {}, [
        c.status === 'running' ? el('i', { className: 'spinner' }) : null,
        document.createTextNode(c.name),
      ]),
      busy
        ? el('div', { className: 'meta running', textContent: c.stage ? `Working — ${c.stage}…` : 'Queued…' })
        : el('div', { className: 'meta', textContent: [c.headline, c.company].filter(Boolean).join(' · ') }),
      el('div', { className: 'actions' }, [
        c.url
          ? el('a', { className: 'btn primary', href: c.url, target: '_blank', rel: 'noreferrer', textContent: 'Open on LinkedIn' })
          : null,
        button('Look up again', '', () =>
          post('/api/linkedin/lookup', {
            // Tied to this contact, so the result replaces this row rather
            // than filing a near-duplicate beside it.
            contactId: c.id,
            name: c.queriedAs || c.name,
            company: c.queriedCompany ?? c.company,
          }).then(pollLinkedIn)
        ),
        button('Watch live', '', () => {
          li.selected = null;
          renderLiTable();
          pollLinkedIn();
        }),
        button('Delete this lookup', 'danger', () => {
          if (!confirm(`Delete the lookup for ${c.name}? The pages cached for it go too.`)) return;
          deleteContacts([c.id]);
        }),
      ]),
    ]),
  ];

  // --- what the search returned, and the verdict on it -------------------
  if (c.candidates?.length) {
    const cleared = c.candidates.filter((x) => (x.confidence ?? 0) >= 0.9);
    parts.push(
      el('div', { className: 'answer' }, [
        el('h4', { textContent: `What the search turned up (${c.candidates.length})` }),
        ...c.candidates.map((cand, i) =>
          candidateCard(cand, i + 1, cand.url && cand.url !== c.url ? (pick) => acceptCandidate(c, pick) : null)
        ),
        el('div', {
          className: 'verdict ' + (cleared.length ? 'good' : 'bad'),
          textContent: cleared.length
            ? `${cleared[0].name} cleared the 90% bar at ${Math.round(cleared[0].confidence * 100)}% — ` +
              'that is the person recorded below.'
            : 'None of these cleared the 90% bar, so no one was recorded.',
        }),
      ])
    );
  }

  if (c.status === 'not found') {
    parts.push(
      el('div', { className: 'answer' }, [
        el('h4', { textContent: 'No confident match' }),
        el('div', { className: 'body error', textContent: c.reason || 'No match above the confidence bar.' }),
        c.html
          ? el('div', { className: 'muted small' }, [
              document.createTextNode('The page markup was saved: '),
              el('a', {
                href: `/api/linkedin/shots/${c.html}`,
                target: '_blank',
                rel: 'noreferrer',
                textContent: c.html,
              }),
            ])
          : null,
      ])
    );
  } else {
    // --- how far away they are -------------------------------------------
    parts.push(
      el('div', { className: 'answer' }, [
        el('h4', {}, [
          document.createTextNode('Connection'),
          el('span', { className: `badge deg-${c.degree}`, textContent: c.degree || 'unknown' }),
        ]),
        el('div', {
          className: 'body',
          textContent:
            c.degree === '1st'
              ? 'A first-degree connection — you already know them, no introduction needed.'
              : c.degree === '2nd'
              ? 'A second-degree connection — one introduction away, through the people below.'
              : c.degree === '3rd'
              ? 'Third degree — no direct path through your network.'
              : 'The profile page did not yield a degree.',
        }),
        c.degreeSource
          ? el('div', { className: 'muted small', textContent: `Taken from the ${c.degreeSource}.` })
          : null,
        // The search result often says plainly what the profile page did not.
        !c.degree && searchDegree(c)
          ? el('div', { className: 'body' }, [
              el('div', {
                className: 'muted small',
                textContent: `The search result for them says ${searchDegree(c)}.`,
              }),
              button(`Use ${searchDegree(c)} from the search result`, '', async () => {
                try {
                  await api(`/api/linkedin/contacts/${c.id}`, {
                    method: 'PATCH',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ degree: searchDegree(c) }),
                  });
                } catch (err) {
                  return toast(err.message, 'bad');
                }
                toast(`Recorded as a ${searchDegree(c)} connection`, 'good');
                await loadContacts();
                selectContact(c.id);
              }),
            ])
          : null,
      ])
    );

    // --- the way in, for a second-degree contact --------------------------
    if (c.degree === '2nd' || c.via?.length || c.mutualPage) {
      const read = c.via?.length || 0;
      const claimed = c.mutualPage?.claimed;
      parts.push(
        el('div', { className: 'answer' }, [
          el('h4', {}, [
            c.stage?.startsWith('mutual connections') ? el('i', { className: 'spinner' }) : null,
            document.createTextNode(
              `Mutual connections (${read}` +
                (claimed && claimed > read ? ` of ${claimed}` : '') +
                ' parsed' +
                (c.mutualPage?.pages > 1 ? `, ${c.mutualPage.pages} pages` : '') +
                ')'
            ),
          ]),
          pageLinks({ ...(c.mutualPage || {}), text: c.mutualPage?.text || c.mutualText }),
          c.mutualPage?.pending
            ? el('div', { className: 'body' }, [
                el('div', {
                  className: 'muted small',
                  textContent:
                    `Not fetched: they are a first-degree connection, so the path through anyone else is moot. ` +
                    (c.mutualPage.claimed ? `LinkedIn says you share ${c.mutualPage.claimed}. ` : ''),
                }),
                button('Fetch mutual connections', '', async () => {
                  try {
                    await post(`/api/linkedin/contacts/${c.id}/mutuals`);
                  } catch (err) {
                    return toast(err.message, 'bad');
                  }
                  toast('Queued — watch it on the right.');
                  pollLinkedIn();
                }),
              ])
            : null,
          read ? mutualPicker(c) : null,
          read || c.mutualPage?.pending
            ? null
            : el('div', {
                className: 'body empty',
                textContent: c.mutualPage
                  ? 'Nobody was parsed from that page — open the saved copy to see why.'
                  : 'No mutual connections page was reached.',
              }),
          claimed && claimed > read && !busy
            ? el('div', {
                className: 'muted small',
                textContent:
                  `LinkedIn reports ${claimed}. Pages are read one every 5 seconds until a page adds nobody new; ` +
                  'if this is short, the list stopped early or ran into the page limit.',
              })
            : null,
        ])
      );
    }
  }

  const shots = shotBlock(c.shots);
  if (shots) {
    parts.push(el('div', { className: 'answer' }, [el('h4', { textContent: 'Pages the agent saw' }), shots]));
  }

  // Relationship strength and a place for what you know about them.
  const strength = el('input', {
    type: 'range',
    min: '1',
    max: '10',
    step: '1',
    value: String(c.strength || 5),
    className: 'strength',
  });
  const readout = el('span', { className: 'badge', textContent: c.strength ? String(c.strength) : 'unscored' });
  strength.addEventListener('input', () => (readout.textContent = strength.value));
  strength.addEventListener('change', async () => {
    await api(`/api/linkedin/contacts/${c.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strength: strength.value }),
    });
    c.strength = Number(strength.value);
    renderLiTable();
  });

  const notes = el('textarea', { rows: 3, value: c.notes || '', placeholder: 'How you know them, what to mention…' });
  notes.addEventListener('blur', async () => {
    if (notes.value === (c.notes || '')) return;
    await api(`/api/linkedin/contacts/${c.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: notes.value }),
    });
    c.notes = notes.value;
  });

  parts.push(
    el('div', { className: 'answer' }, [
      el('h4', {}, [document.createTextNode('Relationship strength'), readout]),
      el('div', { className: 'strength-row' }, [el('span', { className: 'muted small', textContent: '1 cold' }), strength, el('span', { className: 'muted small', textContent: '10 close' })]),
      el('h4', { style: 'margin-top:14px', textContent: 'Notes' }),
      notes,
    ])
  );

  $('#li-detail').replaceChildren(...parts);
}


const shotsShown = () => {
  try {
    return localStorage.getItem('liShots') === '1';
  } catch {
    return false;
  }
};

/** A cached picture of the page the agent read, revealed on request. */
function shotBlock(shots) {
  if (!shots?.length) return null;
  const wrap = el('div', { className: 'shots' });

  const toggle = button('', 'shot-toggle', () => {
    const now = !wrap.classList.contains('open');
    wrap.classList.toggle('open', now);
    try {
      localStorage.setItem('liShots', now ? '1' : '0');
    } catch {
      /* private window; the choice just will not stick */
    }
    label();
  });
  const label = () =>
    (toggle.textContent = wrap.classList.contains('open')
      ? `Hide screenshot${shots.length === 1 ? '' : 's'}`
      : `Show screenshot${shots.length === 1 ? '' : 's'} (${shots.length})`);

  wrap.classList.toggle('open', shotsShown());
  label();

  wrap.append(
    toggle,
    el(
      'div',
      { className: 'shot-list' },
      shots.map((sh) =>
        el('figure', { className: 'shot' }, [
          el('img', { src: `/api/linkedin/shots/${sh.file}`, alt: sh.label, loading: 'lazy' }),
          el('figcaption', { className: 'muted small' }, [
            document.createTextNode(`${sh.label} — ${sh.url || ''} `),
            sh.html
              ? el('a', {
                  href: `/api/linkedin/shots/${sh.html}`,
                  target: '_blank',
                  rel: 'noreferrer',
                  textContent: 'page HTML',
                })
              : null,
          ]),
        ])
      )
    )
  );
  return wrap;
}

/** Picture, name, then title or company — one connection at a glance. */
function personCard(p, onPick, showKnown) {
  const known = showKnown ? networkEntry(p) : null;
  const initials = (p.name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();

  const avatar = p.photo
    ? el('img', { className: 'avatar', src: p.photo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
    : el('span', { className: 'avatar initials', textContent: initials });
  // A LinkedIn photo URL is signed and expires; fall back to initials.
  if (p.photo) {
    avatar.addEventListener('error', () =>
      avatar.replaceWith(el('span', { className: 'avatar initials', textContent: initials }))
    );
  }

  let tick = null;
  if (onPick) {
    tick = el('input', { type: 'checkbox', className: 'person-tick' });
    tick.addEventListener('change', () => onPick(p, tick.checked));
  }

  return el('div', { className: 'person' }, [
    tick,
    avatar,
    el('div', { className: 'person-text' }, [
      p.url
        ? el('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'person-name', textContent: p.name })
        : el('span', { className: 'person-name', textContent: p.name }),
      el('div', { className: 'person-sub', textContent: p.headline || p.company || '', title: p.headline || '' }),
      // Third line: where they stand in your network, which is what the
      // ordering above is based on.
      showKnown
        ? el('div', { className: 'person-rank' }, known
            ? [
                el('span', {
                  className: 'rank-tag' + (known.rank ? '' : ' none'),
                  textContent: known.rank ? `#${known.rank}` : 'unranked',
                }),
                el('span', {
                  className: 'stars-static',
                  textContent: '★'.repeat(known.strength || 0) + '☆'.repeat(5 - (known.strength || 0)),
                  title: known.strength ? `${known.strength} of 5` : 'Not rated yet',
                }),
              ]
            : [el('span', { className: 'muted small', textContent: 'not in your network' })])
        : null,
    ]),
  ]);
}

/** One scraped search result, scored, as the agent saw it. */
function candidateCard(c, rank, onAccept) {
  const pct = Math.round((c.confidence ?? 0) * 100);
  const verdict = pct >= 90 ? 'match' : 'below bar';
  return el('div', { className: 'cand' + (pct >= 90 ? ' hit' : '') }, [
    el('div', { className: 'cand-head' }, [
      el('span', { className: 'cand-rank', textContent: `#${rank}` }),
      c.url
        ? el('a', { href: c.url, target: '_blank', rel: 'noreferrer', textContent: c.name || '(no name)' })
        : el('span', { textContent: c.name || '(no name)' }),
      c.degree ? el('span', { className: `badge deg-${c.degree}`, textContent: c.degree }) : null,
      el('span', { className: 'cand-score' + (pct >= 90 ? ' good' : ''), textContent: `${pct}% ${verdict}` }),
    ]),
    c.headline ? el('div', { className: 'cand-line', textContent: c.headline }) : null,
    c.company && c.company !== c.headline ? el('div', { className: 'cand-line muted', textContent: c.company }) : null,
    el('div', { className: 'cand-foot' }, [
      el('span', {
        className: 'muted small',
        textContent:
          `name ${Math.round((c.nameScore ?? 0) * 100)}%` +
          (c.companyScore === null || c.companyScore === undefined
            ? ', no company to check'
            : `, company ${Math.round(c.companyScore * 100)}%`),
      }),
      // The bar stops the agent guessing; it should not stop you deciding.
      onAccept ? button('This is them', '', () => onAccept(c)) : null,
    ]),
  ]);
}

/** The right pane while the agent is working: what it is doing, and what it reads. */
function renderActivity(q) {
  const events = q.activity || [];
  const pane = $('#li-detail');

  if (!events.length) {
    pane.replaceChildren(
      el('div', { className: 'detail-head' }, [
        el('h2', { textContent: q.running ? 'Working…' : 'Live activity' }),
        el('div', {
          className: 'meta',
          textContent: q.running
            ? 'Watching the agent.'
            : 'Queue a lookup and what the agent finds will appear here. Select a contact to see its record.',
        }),
      ])
    );
    return;
  }

  const nodes = [];
  const start = events.find((e) => e.type === 'start');
  nodes.push(
    el('div', { className: 'detail-head' }, [
      el('h2', {}, [
        q.running ? el('i', { className: 'spinner' }) : null,
        document.createTextNode(start ? start.name : 'Live activity'),
      ]),
      el('div', {
        className: 'meta',
        textContent: start?.company ? `Searching as “${start.name} ${start.company}”` : 'Live activity',
      }),
      // Unreachable now: the pane only shows this trail when nothing is
      // selected, and "Watch live" is what clears the selection.
      null,
    ])
  );

  for (const e of events) {
    if (e.type === 'start') continue;

    if (e.type === 'search') {
      nodes.push(step('Searching LinkedIn', `“${[e.query.name, e.query.company].filter(Boolean).join(' ')}”`, e.t));
    } else if (e.type === 'results') {
      nodes.push(
        step(
          `Read ${e.count} result${e.count === 1 ? '' : 's'}`,
          e.count ? `Top ${Math.min(3, e.top.length)}, scored against the ${Math.round((e.threshold ?? 0.9) * 100)}% bar:` : 'Nothing came back.',
          e.t,
          e.top.map((c, i) => candidateCard(c, i + 1))
        )
      );
    } else if (e.type === 'accepted') {
      nodes.push(
        step(
          `Match accepted — ${Math.round(e.confidence * 100)}%`,
          `${e.name} (result #${e.rank}) cleared the ${Math.round(e.threshold * 100)}% bar.`,
          e.t,
          [],
          'good'
        )
      );
    } else if (e.type === 'mutual-skipped') {
      nodes.push(
        step(
          'Skipped the mutual connections',
          e.reason === 'already fetched for this contact'
            ? `${e.reason} — the ones on record were kept.`
            : `${e.reason} — "${e.text}" was recorded and can be fetched on request.`,
          e.t
        )
      );
    } else if (e.type === 'mutual-dead') {
      nodes.push(
        step('That link went nowhere', 'Clicking it neither navigated nor opened a panel; trying the profile.', e.t, [], 'bad')
      );
    } else if (e.type === 'no-mutual-link') {
      nodes.push(step('No mutual-connections link on that result', 'Trying the profile instead.', e.t));
    } else if (e.type === 'rejected') {
      nodes.push(
        step(
          'No confident match',
          e.reason + (e.hadMutualLink ? ' Its mutual-connections link was left alone.' : ''),
          e.t,
          [],
          'bad'
        )
      );
    } else if (e.type === 'opening') {
      nodes.push(step('Opening the profile', e.name, e.t));
    } else if (e.type === 'profile') {
      const p = e.profile;
      nodes.push(
        step(
          'Read the profile',
          '',
          e.t,
          [
            el('div', { className: 'cand' }, [
              el('div', { className: 'cand-head' }, [
                el('a', { href: p.url, target: '_blank', rel: 'noreferrer', textContent: p.name || '(no name)' }),
                p.degree ? el('span', { className: `badge deg-${p.degree}`, textContent: p.degree }) : null,
              ]),
              p.headline ? el('div', { className: 'cand-line', textContent: p.headline }) : null,
              p.company ? el('div', { className: 'cand-line muted', textContent: p.company }) : null,
            ]),
          ],
          'good'
        )
      );
    } else if (e.type === 'shared-page') {
      nodes.push(
        step(
          `Mutual connections — page ${e.page}`,
          (e.added ? `${e.added} new on this page, ${e.total} so far.` : `Nothing new on this page; ${e.total} in total.`) +
            (e.waitedMs ? ` Waited ${(e.waitedMs / 1000).toFixed(1)}s before loading it.` : ''),
          e.t
        )
      );
    } else if (e.type === 'shared-start') {
      nodes.push(step('Following the shared connections', '', e.t));
    } else if (e.type === 'shared') {
      nodes.push(
        step(
          `${e.count} contact${e.count === 1 ? '' : 's'} read from the mutual connections page` +
            (e.claimed && e.claimed > e.count ? ` — LinkedIn says ${e.claimed}` : ''),
          e.count
            ? e.claimed && e.claimed > e.count
              ? 'People you could be introduced through. Only the first page is read; open the link above for the rest.'
              : 'People you could be introduced through:'
            : 'The page listed nobody.',
          e.t,
          [
            pageLinks(e),
            el('div', { className: 'people' }, e.via.map(personCard)),
          ]
        )
      );
    } else if (e.type === 'shot') {
      const block = shotBlock([e]);
      if (block) nodes.push(step(`Captured the ${e.label.toLowerCase()} page`, '', e.t, [block]));
    } else if (e.type === 'error') {
      nodes.push(step('Stopped', e.message, e.t, [], 'bad'));
    }
  }

  pane.replaceChildren(...nodes.filter(Boolean));
}

/**
 * Where a set of mutual connections came from: the link that was followed,
 * the page it landed on, and the copy saved for debugging.
 */
function pageLinks(e) {
  const rows = [];
  if (e.text) {
    rows.push(
      el('div', { className: 'pagelink' }, [
        el('span', { className: 'muted small', textContent: 'Link followed: ' }),
        e.link
          ? el('a', { href: e.link, target: '_blank', rel: 'noreferrer', textContent: e.text })
          : el('span', { textContent: e.text }),
      ])
    );
  }
  if (e.pageUrl) {
    rows.push(
      el('div', { className: 'pagelink' }, [
        el('span', { className: 'muted small', textContent: 'Page read: ' }),
        el('a', { href: e.pageUrl, target: '_blank', rel: 'noreferrer', textContent: e.pageUrl }),
      ])
    );
  }
  if (e.html) {
    rows.push(
      el('div', { className: 'pagelink' }, [
        el('span', { className: 'muted small', textContent: 'Saved copy: ' }),
        el('a', {
          href: `/api/linkedin/shots/${e.html}`,
          target: '_blank',
          rel: 'noreferrer',
          textContent: e.html,
        }),
      ])
    );
  }
  return rows.length ? el('div', { className: 'pagelinks' }, rows) : null;
}

/** One line of the activity trail, optionally with content underneath. */
function step(title, detail, t, extra = [], tone = '') {
  return el('div', { className: 'answer act ' + tone }, [
    el('h4', {}, [
      document.createTextNode(title),
      el('span', { className: 'muted small act-time', textContent: clock(t) }),
    ]),
    detail ? el('div', { className: 'body small', textContent: detail }) : null,
    ...extra,
  ]);
}

let liPolling = false;
async function pollLinkedIn() {
  if (liPolling || parseHash().view !== 'linkedin') return;
  liPolling = true;
  try {
    const q = await api('/api/linkedin/queue');
    const waiting = q.pending.length;
    const clear = $('#li-clear-queue');
    clear.disabled = !waiting;
    clear.textContent = waiting ? `Clear queue (${waiting})` : 'Clear queue';

    const bar = $('#li-queue');
    bar.classList.toggle('hidden', !q.running && !waiting);
    if (q.running || waiting) {
      bar.textContent = q.running
        ? `Looking up ${q.current?.name || '…'}${waiting ? ` · ${waiting} waiting` : ''}`
        : `${waiting} waiting`;
    }

    // The last person searched for, repeatable in one click.
    li.last = q.last || null;
    const again = $('#li-again');
    again.classList.toggle('hidden', !li.last);
    if (li.last) {
      const when = new Date(li.last.at).toLocaleString();
      again.textContent = `Search again: ${li.last.name}`;
      again.title =
        `Last searched ${when}` +
        (li.last.company ? ` — ${li.last.name} at ${li.last.company}` : '') +
        '. Runs the LinkedIn path search again.';
    }

    const log = $('#li-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(
      ...q.log.map((l) => el('div', { textContent: `${clock(l.t)}  ${l.msg}`, title: new Date(l.t).toLocaleString() }))
    );
    if (atBottom) log.scrollTop = log.scrollHeight;

    await liSession();
    await loadNetworkKeys();
    await loadContacts();

    // Picking a contact is a decision: the pane stays on it, even while the
    // agent works on someone else. The live trail is what you get when you
    // have not chosen anyone, or after "Watch live" clears the choice.
    // Skipped entirely while you are typing in the pane.
    const busy = document.activeElement?.closest?.('#li-detail');
    if (!busy) {
      if (li.selected) selectContact(li.selected);
      else renderActivity(q);
    }
  } catch {
    /* next tick */
  } finally {
    liPolling = false;
  }
}

let liWasBusy = false;

setInterval(async () => {
  const view = parseHash().view;
  if (view === 'linkedin') return pollLinkedIn();

  // On a list, the Connection and Connected via columns track the agent
  // without you having to go and watch it.
  if (view !== 'investors' || !state.listId || !linkedinMapping()) return;
  let q;
  try {
    q = await api('/api/linkedin/queue');
  } catch {
    return;
  }
  const busy = !!(q.running || q.pending.length);
  if (busy || liWasBusy) await refreshConnections();
  liWasBusy = busy;
}, 3000);


// ============================================================== my network
// The people you know directly, gathered from the mutual connections of the
// contacts you look up. Strength is how well you know them; rank is the order
// you would actually ask them in.

const nw = { people: [], filter: '', strengths: new Set(), sort: 'rank', picked: new Set() };

/** Five clickable stars. Clicking the current rating clears it. */
function stars(value, onPick) {
  const box = el('span', { className: 'stars' });
  for (let i = 1; i <= 5; i++) {
    const star = el('button', {
      className: 'star' + (value >= i ? ' on' : ''),
      textContent: value >= i ? '★' : '☆',
      title: `${i} of 5`,
    });
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(value === i ? null : i);
    });
    box.append(star);
  }
  return box;
}

async function loadNetwork() {
  nw.people = await api('/api/linkedin/network');
  renderNetwork();
}

async function patchPerson(id, fields) {
  const updated = await api(`/api/linkedin/network/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
  const i = nw.people.findIndex((p) => p.id === id);
  if (i >= 0) nw.people[i] = updated;
  renderNetwork();
}

function networkVisible() {
  const q = nw.filter.trim().toLowerCase();
  let rows = nw.people.filter((p) => {
    if (nw.strengths.size) {
      const key = p.strength ? String(p.strength) : 'none';
      if (!nw.strengths.has(key)) return false;
    }
    if (!q) return true;
    return [p.name, p.headline, ...(p.sources || []).map((s) => s.name)].some((v) =>
      String(v ?? '').toLowerCase().includes(q)
    );
  });

  const byName = (a, b) => a.name.localeCompare(b.name);
  rows = [...rows].sort((a, b) => {
    if (nw.sort === 'name') return byName(a, b);
    // Reach: who opens the most doors. The point of adding in bulk across
    // several investors is finding the people who appear in more than one.
    if (nw.sort === 'reach') return (b.sources?.length || 0) - (a.sources?.length || 0) || byName(a, b);
    if (nw.sort === 'strength') return (b.strength ?? -1) - (a.strength ?? -1) || byName(a, b);
    if (nw.sort === 'added') return (b.addedAt || '').localeCompare(a.addedAt || '');
    // by rank: unranked sink to the bottom rather than sorting as zero
    const ar = a.rank ?? Infinity;
    const br = b.rank ?? Infinity;
    return ar - br || byName(a, b);
  });
  return rows;
}

function renderNetwork() {
  const rows = networkVisible();
  $('#nw-count').textContent =
    `${rows.length} of ${nw.people.length} ${nw.people.length === 1 ? 'person' : 'people'}` +
    (nw.picked.size ? ` · ${nw.picked.size} selected` : '');
  $('#nw-delete').classList.toggle('hidden', !nw.picked.size);
  $('#nw-delete').textContent = `Remove ${nw.picked.size} selected`;
  $('#nw-lookup').classList.toggle('hidden', !nw.picked.size);
  $('#nw-lookup').textContent = `Look up ${nw.picked.size} on LinkedIn`;
  $('#nw-sort').value = nw.sort;

  // Strength filter, with counts.
  const buckets = [
    ['5', '★★★★★'], ['4', '★★★★'], ['3', '★★★'], ['2', '★★'], ['1', '★'], ['none', 'Unrated'],
  ];
  $('#nw-strength').replaceChildren(
    ...buckets.map(([key, label]) => {
      const n = nw.people.filter((p) => (p.strength ? String(p.strength) : 'none') === key).length;
      const chip = el('button', {
        className: 'chip' + (nw.strengths.has(key) ? ' on' : ''),
        textContent: `${label} ${n}`,
      });
      chip.addEventListener('click', () => {
        nw.strengths.has(key) ? nw.strengths.delete(key) : nw.strengths.add(key);
        renderNetwork();
      });
      return chip;
    }),
    nw.strengths.size
      ? (() => {
          const b = el('button', { className: 'chip clear', textContent: 'Clear' });
          b.addEventListener('click', () => {
            nw.strengths = new Set();
            renderNetwork();
          });
          return b;
        })()
      : null
  );

  const allTicked = rows.length > 0 && rows.every((p) => nw.picked.has(p.id));
  const someTicked = !allTicked && rows.some((p) => nw.picked.has(p.id));
  const tickAll = el('input', { type: 'checkbox', checked: allTicked, title: 'Select all shown' });
  tickAll.indeterminate = someTicked;
  tickAll.addEventListener('change', () => {
    for (const p of rows) (tickAll.checked ? nw.picked.add(p.id) : nw.picked.delete(p.id));
    renderNetwork();
  });

  if (!nw.people.length) {
    $('#nw-list').replaceChildren(
      el('p', {
        className: 'muted',
        textContent:
          'Nobody here yet. Open a second-degree contact on the LinkedIn page, tick the mutual connections ' +
          'who could introduce you, and add them.',
      })
    );
    return;
  }

  $('#nw-list').replaceChildren(
    el('div', { className: 'nw-row nw-head' }, [
      tickAll,
      el('span', { className: 'muted small', textContent: 'Rank' }),
      el('span', { className: 'muted small', textContent: 'Person' }),
      el('span', { className: 'muted small', textContent: 'Strength · paths' }),
      el('span', { className: 'muted small', textContent: 'Notes' }),
    ]),
    ...rows.map((p) => {
      const tick = el('input', { type: 'checkbox', checked: nw.picked.has(p.id) });
      tick.addEventListener('change', () => {
        tick.checked ? nw.picked.add(p.id) : nw.picked.delete(p.id);
        renderNetwork();
      });

      const rank = el('input', {
        type: 'number',
        className: 'rank-input',
        value: p.rank ?? '',
        placeholder: '—',
        min: '1',
      });
      rank.addEventListener('click', (e) => e.stopPropagation());
      rank.addEventListener('change', () => patchPerson(p.id, { rank: rank.value }));

      const notes = el('input', { type: 'text', className: 'nw-notes', value: p.notes || '', placeholder: 'Notes…' });
      notes.addEventListener('change', () => patchPerson(p.id, { notes: notes.value }));

      return el('div', { className: 'nw-row' }, [
        tick,
        el('span', { className: 'rank-cell' }, rank),
        personCard(p),
        el('div', { className: 'nw-meta' }, [
          el('div', { className: 'strength-line' }, [
            stars(p.strength || 0, (v) => patchPerson(p.id, { strength: v })),
            Number.isFinite(p.shared)
              ? el('span', {
                  className: 'muted small',
                  textContent: `${p.shared} shared`,
                  title:
                    p.strengthSource === 'derived'
                      ? `Rated from the ${p.shared} connections you have in common`
                      : `${p.shared} connections in common`,
                })
              : null,
            p.strengthSource === 'you'
              ? el('span', { className: 'muted small', textContent: 'yours', title: 'You set this rating' })
              : null,
          ]),
          p.degree && p.degree !== '1st'
            ? el('div', {
                className: 'muted small warn',
                textContent: `LinkedIn says ${p.degree}, not a direct connection`,
              })
            : null,
          (p.sources || []).length
            ? el('div', { className: 'muted small' }, [
                p.sources.length > 1
                  ? el('span', { className: 'badge full', textContent: `${p.sources.length} paths` })
                  : null,
                document.createTextNode(' Path to ' + p.sources.map((s) => s.name).join(', ')),
              ])
            : null,
        ]),
        notes,
      ]);
    })
  );
}

$('#nw-search').addEventListener('input', (e) => {
  nw.filter = e.target.value;
  renderNetwork();
});
$('#nw-sort').addEventListener('change', (e) => {
  nw.sort = e.target.value;
  renderNetwork();
});

// The people here have known profiles, so a lookup goes straight to the
// profile: it confirms the degree and refreshes their title and company.
$('#nw-lookup').addEventListener('click', async () => {
  const chosen = nw.people.filter((p) => nw.picked.has(p.id));
  if (!chosen.length) return;

  const withUrl = chosen.filter((p) => p.url);
  if (!withUrl.length) return alert('None of those have a LinkedIn address on file to look up.');

  const skipped = chosen.length - withUrl.length;
  const mins = Math.max(1, Math.round((withUrl.length * 12) / 60));
  if (
    !confirm(
      `Look up ${withUrl.length} ${withUrl.length === 1 ? 'person' : 'people'} on LinkedIn?` +
        (skipped ? ` (${skipped} have no profile link and will be skipped.)` : '') +
        `\n\nOne at a time, paced — roughly ${mins} minute${mins === 1 ? '' : 's'}.`
    )
  ) {
    return;
  }

  try {
    await post('/api/linkedin/lookup', {
      people: withUrl.map((p) => ({ name: p.name, url: p.url, company: p.headline || '' })),
    });
  } catch (err) {
    return alert(err.message);
  }
  nw.picked.clear();
  renderNetwork();
  if (confirm('Queued. Watch them on the LinkedIn page?')) location.hash = '#/linkedin';
});

$('#nw-delete').addEventListener('click', async () => {
  const ids = [...nw.picked];
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length} from your network?`)) return;
  await post('/api/linkedin/network/delete', { ids });
  nw.picked.clear();
  loadNetwork();
});

/**
 * Strength from the connections you share with each person — a number their
 * profile states, gathered when they were looked up. Nothing you rated by
 * hand is overwritten unless you say so.
 */
$('#nw-strength').addEventListener('click', async () => {
  let r;
  try {
    r = await post('/api/linkedin/network/refresh-strength');
  } catch (err) {
    return toast(err.message, 'bad');
  }
  await loadNetwork();

  if (!r.set && r.missing === r.people) {
    return toast(
      'No shared-connection counts yet — look these people up on LinkedIn first, which fetches them.',
      'bad'
    );
  }
  if (r.kept && !r.set && confirm(`${r.kept} already have a rating you set. Replace those too?`)) {
    const f = await post('/api/linkedin/network/refresh-strength', { overwrite: true });
    await loadNetwork();
    return toast(`${f.set} re-rated from shared connections`, 'good');
  }
  toast(
    [
      r.set ? `${r.set} rated from shared connections` : 'Nothing to change',
      r.kept ? `${r.kept} left as you set them` : '',
      r.missing ? `${r.missing} not looked up yet` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    r.set ? 'good' : ''
  );
});

// Everything needed is already on disk: the mutual-connection lists of every
// lookup. This re-reads them rather than going back to LinkedIn.
$('#nw-resync').addEventListener('click', async () => {
  let r;
  try {
    r = await post('/api/linkedin/network/resync');
  } catch (err) {
    return toast(err.message, 'bad');
  }
  await loadNetwork();
  const bits = [
    r.details ? `${r.details} updated` : '',
    r.paths ? `${r.paths} new path${r.paths === 1 ? '' : 's'} recorded` : '',
  ].filter(Boolean);
  toast(bits.length ? bits.join(' · ') : 'Already up to date with everything fetched', bits.length ? 'good' : '');
});

// Rank is yours to set, but gaps accumulate; this closes them in the order
// currently on screen.
$('#nw-renumber').addEventListener('click', async () => {
  const rows = networkVisible();
  if (!rows.length) return;
  if (!confirm(`Renumber these ${rows.length} as 1…${rows.length}, in the order shown?`)) return;
  await post('/api/linkedin/network/renumber', { ids: rows.map((p) => p.id) });
  loadNetwork();
});

// --------------------------------------------------------------------- boot

await route();
poll();
