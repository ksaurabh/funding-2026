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
  const top = ['settings', 'playbooks', 'linkedin'].includes(parts[0]) ? parts[0] : 'lists';
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
  $('#settings-tab').classList.toggle('active', view === 'settings');
  $('#playbooks-tab').classList.toggle('active', view === 'playbooks');
  $('#linkedin-tab').classList.toggle('active', view === 'linkedin');
  $('#export').href = `/api/lists/${listId}/export.csv`;

  await loadCost();
  if (view === 'lists') await loadLists();
  if (view === 'playbooks') await loadPlaybookIndex();
  if (view === 'linkedin') {
    await fillLiListPickers();
    await pollLinkedIn();
  }
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

async function loadInvestors() {
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
function applyWidths(shown) {
  const cols = [
    el('col', { style: `width:${TICK_W}px` }),
    ...shown.map((c, i) => el('col', { style: `width:${widthOf(c, i)}px` })),
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

  const group = applyWidths(shown);
  $('#investor-table thead').replaceChildren(
    el('tr', {}, [
      el('th', { className: 'tick' }, selectAll),
      ...shown.map((c, i) =>
        el('th', {}, [el('span', { className: 'th-text', textContent: c, title: c }), resizeHandle(c, i, group)])
      ),
      el('th', { textContent: 'Answers' }),
    ])
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
        el('td', {}, status),
      ]);
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
  paths.title = state.list?.linkedin?.nameColumn
    ? `Queue the people in "${state.list.linkedin.nameColumn}" for a LinkedIn path lookup`
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
  $('#column-config').replaceChildren(
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

/** Queue one row's person for a LinkedIn path lookup. */
async function findPathForRow(row) {
  const map = state.list?.linkedin;
  if (!map?.nameColumn) return askColumnMapping(row);
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
    return alert(`No name in "${map.nameColumn}" for ${rows.length === 1 ? 'that row' : 'any of those rows'}.`);
  }

  try {
    await post('/api/linkedin/lookup', { people });
  } catch (err) {
    return alert(err.message);
  }

  const who = people.length === 1 ? people[0].name : `${people.length} people`;
  if (confirm(`Queued ${who} for a LinkedIn path lookup.\n\nOpen the LinkedIn tab?`)) {
    location.hash = '#/linkedin';
  }
}

/** Asked once per list; the answer is saved on the list. */
function askColumnMapping(rowToQueueAfter) {
  const columns = state.investors.columns || [];
  const fill = (sel, guess, blank) =>
    sel.replaceChildren(
      el('option', { value: '', textContent: blank }),
      ...columns.map((c) =>
        el('option', { value: c, textContent: c || '(unnamed)', selected: c === guess })
      )
    );

  fill($('#li-map-name'), guessColumn(columns, PERSON_HINTS), '— choose —');
  fill($('#li-map-company'), guessColumn(columns, COMPANY_HINTS), '— none —');

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
  const map = state.list?.linkedin;
  if (!map?.nameColumn) return askColumnMapping(target.rows);
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
  session: { open: false, loggedIn: false },
};

const DEGREE_LABEL = { '1st': 'You know them', '2nd': 'One hop away', '3rd': 'Three degrees out' };

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
    ? 'Sign in to LinkedIn in the agent window; queued lookups will start by themselves.'
    : 'Queue names now — they run once you start the agent session.';
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

$('#li-stop').addEventListener('click', () => liSession('stop'));

async function queueLookup(people) {
  await post('/api/linkedin/lookup', Array.isArray(people) ? { people } : people);
  await pollLinkedIn();
  // Nothing will happen until the browser is up, so offer to bring it up.
  if (!li.session.loggedIn && confirm('Start the LinkedIn agent session now so these can run?')) {
    await liSession('start');
    if (li.session.open && !li.session.loggedIn) await liSession('wait-login');
    await post('/api/linkedin/queue/resume').catch(() => {});
    pollLinkedIn();
  }
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

function renderLiTable() {
  const rows = liVisible();
  $('#li-table thead').replaceChildren(
    el('tr', {}, [
      el('th', { textContent: 'Person' }),
      el('th', { textContent: 'Company' }),
      el('th', { textContent: 'Connection' }),
      el('th', { textContent: 'Via' }),
      el('th', { textContent: 'Strength' }),
    ])
  );

  $('#li-table tbody').replaceChildren(
    ...rows.map((c) => {
      const degree = c.degree
        ? el('span', { className: `badge deg-${c.degree}`, textContent: c.degree, title: DEGREE_LABEL[c.degree] || '' })
        : el('span', { className: 'badge err', textContent: c.status === 'not found' ? 'not found' : '—' });

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

      const tr = el('tr', { className: c.id === li.selected ? 'selected' : '' }, [
        el('td', { textContent: c.name, title: c.headline || '' }),
        el('td', { textContent: c.company || '', title: c.company || '' }),
        el('td', {}, degree),
        el('td', { textContent: c.via?.length ? String(c.via.length) : '' }),
        el('td', {}, strength),
      ]);
      tr.addEventListener('click', () => selectContact(c.id));
      return tr;
    })
  );
}

function selectContact(id) {
  li.selected = id;
  renderLiTable();
  const c = li.contacts.find((x) => x.id === id);
  if (!c) return;

  const parts = [
    el('div', { className: 'detail-head' }, [
      el('h2', { textContent: c.name }),
      el('div', { className: 'meta', textContent: [c.headline, c.company].filter(Boolean).join(' · ') }),
      el('div', { className: 'actions' }, [
        c.url
          ? el('a', { className: 'btn primary', href: c.url, target: '_blank', rel: 'noreferrer', textContent: 'Open on LinkedIn' })
          : null,
        button('Look up again', '', () => post('/api/linkedin/lookup', { name: c.queriedAs || c.name, company: c.company }).then(pollLinkedIn)),
        button('Watch live', '', () => {
          li.selected = null;
          renderLiTable();
          pollLinkedIn();
        }),
        button('Remove', 'danger', async () => {
          if (!confirm(`Remove ${c.name} from the contact book?`)) return;
          await api(`/api/linkedin/contacts/${c.id}`, { method: 'DELETE' });
          li.selected = null;
          loadContacts();
          $('#li-detail').replaceChildren(el('p', { className: 'muted pad', textContent: 'Select a contact.' }));
        }),
      ]),
    ]),
  ];

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
    parts.push(
      el('div', { className: 'answer' }, [
        el('h4', {}, [
          document.createTextNode('Connection'),
          el('span', { className: `badge deg-${c.degree}`, textContent: c.degree || 'unknown' }),
        ]),
        el('div', {
          className: 'body',
          textContent:
            (DEGREE_LABEL[c.degree] || 'Degree not established') +
            (c.confidence ? ` · matched with ${Math.round(c.confidence * 100)}% confidence` : ''),
        }),
      ])
    );

    if (c.degree === '2nd') {
      parts.push(
        el('div', { className: 'answer' }, [
          el('h4', { textContent: `Paths in (${c.via?.length || 0})` }),
          c.via?.length
            ? el(
                'div',
                { className: 'cites' },
                c.via.map((v) =>
                  el('a', { href: v.url, target: '_blank', rel: 'noreferrer', textContent: v.name })
                )
              )
            : el('div', { className: 'body empty', textContent: 'No shared connections were listed.' }),
        ])
      );
    }
  }

  if (c.candidates?.length) {
    parts.push(
      el('div', { className: 'answer' }, [
        el('h4', { textContent: `What the search turned up (${c.candidates.length})` }),
        ...c.candidates.map((cand, i) => candidateCard(cand, i + 1)),
      ])
    );
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

/** One scraped search result, scored, as the agent saw it. */
function candidateCard(c, rank) {
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
    el('div', {
      className: 'muted small',
      textContent:
        `name ${Math.round((c.nameScore ?? 0) * 100)}%` +
        (c.companyScore === null || c.companyScore === undefined
          ? ', no company to check'
          : `, company ${Math.round(c.companyScore * 100)}%`),
    }),
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
      li.selected
        ? el('div', { className: 'actions' }, [button('Back to contact', '', () => selectContact(li.selected))])
        : null,
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
    } else if (e.type === 'rejected') {
      nodes.push(step('No confident match', e.reason, e.t, [], 'bad'));
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
    } else if (e.type === 'shared-start') {
      nodes.push(step('Following the shared connections', '', e.t));
    } else if (e.type === 'shared') {
      nodes.push(
        step(
          `${e.count} path${e.count === 1 ? '' : 's'} in`,
          e.count ? 'People you could be introduced through:' : 'None listed.',
          e.t,
          [
            el(
              'div',
              { className: 'cites' },
              e.via.map((v) => el('a', { href: v.url, target: '_blank', rel: 'noreferrer', textContent: v.name }))
            ),
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
    const bar = $('#li-queue');
    bar.classList.toggle('hidden', !q.running && !q.pending.length);
    bar.textContent = q.running
      ? `Looking up ${q.current?.name || '…'}${q.pending.length ? ` · ${q.pending.length} waiting` : ''}`
      : q.pending.length
      ? `${q.pending.length} waiting`
      : '';

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
    await loadContacts();

    // The pane shows the work while it is happening, and the selected contact
    // the rest of the time — unless you are typing in it.
    const busy = document.activeElement?.closest?.('#li-detail');
    if (!busy) {
      if (q.running || (!li.selected && (q.activity || []).length)) renderActivity(q);
      else if (li.selected) selectContact(li.selected);
      else renderActivity(q);
    }
  } catch {
    /* next tick */
  } finally {
    liPolling = false;
  }
}

setInterval(() => {
  if (parseHash().view === 'linkedin') pollLinkedIn();
}, 3000);

// --------------------------------------------------------------------- boot

await route();
poll();
