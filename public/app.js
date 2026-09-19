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
const money = (n) =>
  n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0.00';

const state = {
  lists: [],
  cost: null,
  playbooks: [],
  running: false,
  listId: null,
  list: null,
  investors: { columns: [], csvColumns: [], rows: [], stepCount: 0 },
  schema: { fields: {} },
  valueFilters: {}, // { column: Set(selected values) }; '' means blank
  playbook: null,
  selected: null,
  filter: '',
};

// ------------------------------------------------------------------ routing
// #/lists | #/list/<id>/investors | #/list/<id>/playbook | #/settings

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'lists').split('/');
  if (parts[0] === 'list' && parts[1]) return { view: parts[2] || 'investors', listId: parts[1] };
  const top = ['settings', 'playbooks'].includes(parts[0]) ? parts[0] : 'lists';
  return { view: top, listId: null };
}

async function route() {
  const { view, listId } = parseHash();

  if (listId && listId !== state.listId) {
    state.listId = listId;
    state.selected = null;
    state.filter = '';
    state.valueFilters = {};
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
  $('#export').href = `/api/lists/${listId}/export.csv`;

  await loadCost();
  if (view === 'lists') await loadLists();
  if (view === 'playbooks') await loadPlaybookIndex();
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
  // Drop filters for columns that are no longer dropdowns.
  for (const col of Object.keys(state.valueFilters)) {
    if (!enumColumns().includes(col)) delete state.valueFilters[col];
  }
  renderFilters();
  renderTable();
}

const fields = () => state.schema.fields || {};
const fieldFor = (col) => fields()[col];
// In the list's own column order, not the object's.
const columnsWhere = (pred) => (state.investors.columns || []).filter((c) => fields()[c] && pred(fields()[c]));
const enumColumns = () => columnsWhere((f) => f.type === 'enum');
const shownColumns = () => columnsWhere((f) => f.show);
const cellValue = (row, col) => String(row[col] ?? '').trim();

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
  !!state.filter.trim() || Object.values(state.valueFilters).some((v) => v.size);

function visibleRows() {
  const q = state.filter.trim().toLowerCase();
  return state.investors.rows.filter((r) => {
    if (!matchesValueFilters(r)) return false;
    if (!q) return true;
    return state.investors.columns.some((c) => String(r[c] ?? '').toLowerCase().includes(q));
  });
}

function renderFilters() {
  const bar = $('#filters');
  const cols = enumColumns();
  bar.classList.toggle('hidden', !cols.length);
  if (!cols.length) return;

  const active = Object.values(state.valueFilters).some((v) => v.size);

  bar.replaceChildren(
    ...cols.map((col) => {
      const counts = new Map();
      for (const r of state.investors.rows) {
        const v = cellValue(r, col);
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      const chosen = state.valueFilters[col] || new Set();
      const values = [...new Set([...(fieldFor(col)?.values || []), ...counts.keys()])].filter((v) => v !== '');
      if (counts.get('')) values.push('');

      return el('div', { className: 'filter-group' }, [
        el('span', { className: 'filter-label', textContent: col }),
        ...values.map((v) => {
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
      ]);
    }),
    active
      ? (() => {
          const b = el('button', { className: 'chip clear', textContent: 'Clear filters' });
          b.addEventListener('click', () => {
            state.valueFilters = {};
            renderFilters();
            renderTable();
          });
          return b;
        })()
      : null
  );
}

function renderTable() {
  const { stepCount = 0 } = state.investors;
  const shown = shownColumns();
  $('#investor-table thead').replaceChildren(
    el('tr', {}, [...shown.map((c) => el('th', { textContent: c })), el('th', { textContent: 'Answers' })])
  );

  const rows = visibleRows();
  $('#count').textContent = `${rows.length} of ${state.investors.rows.length} rows`;
  renderRunButtons(rows);

  $('#investor-table tbody').replaceChildren(
    ...rows.map((r) => {
      const status = el('span', {
        className: 'badge ' + (r.__errors ? 'err' : stepCount && r.__done >= stepCount ? 'full' : ''),
        textContent: stepCount ? `${r.__done}/${stepCount}` : '—',
      });
      const tr = el('tr', { className: r.__id === state.selected ? 'selected' : '' }, [
        ...shown.map((c) => el('td', { className: 'cell-edit' }, editableCell(r, c, fieldFor(c)))),
        el('td', {}, status),
      ]);
      tr.addEventListener('click', () => selectInvestor(r.__id));
      return tr;
    })
  );
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
      renderFilters();
      renderTable();
    } catch (err) {
      alert(err.message);
      sel.value = current;
    }
  });
  return sel;
}

/** Label the run buttons with the set they will run on. */
function renderRunButtons(rows) {
  const filtered = isFiltered();
  const unanswered = rows.filter((r) => r.__done < state.investors.stepCount);

  const all = $('#run-all');
  all.textContent = filtered ? `Run ${rows.length} filtered` : `Run all ${rows.length}`;
  all.disabled = !rows.length || state.running;
  all.title = filtered
    ? 'Run the playbook on the rows matching the current filter'
    : 'Run the playbook on every row in this list';

  const rest = $('#run-unanswered');
  rest.textContent = `Run unanswered (${unanswered.length})`;
  rest.disabled = !unanswered.length || state.running;
  rest.title = filtered
    ? 'Run only the filtered rows that are missing answers'
    : 'Run only the rows that are missing answers';
}

async function selectInvestor(id) {
  state.selected = id;
  renderTable();
  const data = await api(`/api/lists/${state.listId}/investors/${id}`);
  const name = data.investor[data.columns[0]];

  const head = el('div', { className: 'detail-head' }, [
    el('h2', { textContent: name }),
    el('div', {
      className: 'meta',
      textContent: data.updatedAt ? 'Last run ' + new Date(data.updatedAt).toLocaleString() : 'Never run',
    }),
    el('div', { className: 'actions' }, [
      button('Run playbook on this row', 'primary', () => run({ investorIds: [id] })),
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

  const raw = el('details', { className: 'answer' }, [
    el('summary', { textContent: 'CSV row data' }),
    el('pre', { textContent: data.columns.map((c) => `${c}: ${data.investor[c]}`).join('\n') }),
  ]);

  $('#detail').replaceChildren(head, ...answers, raw);
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
  renderTable();
});

// --------------------------------------------------- editable-column config

$('#columns-btn').addEventListener('click', async () => {
  await renderColumnConfig();
  $('#columns-dialog').showModal();
});

$('#columns-dialog').addEventListener('close', () => loadInvestors());

async function saveSchema(fields) {
  state.schema = await api(`/api/lists/${state.listId}/schema`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
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

  const rows = info.columns.map((c) => {
    const field = all[c.name] || { type: 'text', values: [], custom: !c.imported, show: true };
    const update = (patch) => saveSchema({ ...all, [c.name]: { ...field, ...patch } });

    const show = el('input', { type: 'checkbox', checked: field.show });
    show.addEventListener('change', () => update({ show: show.checked }));

    const type = el('select', { className: 'type-pick' }, [
      el('option', { value: 'text', textContent: 'Free text', selected: field.type === 'text' }),
      el('option', {
        value: 'enum',
        textContent: c.tooMany && field.type !== 'enum' ? 'Dropdown (too many values)' : 'Dropdown',
        selected: field.type === 'enum',
        disabled: c.tooMany && field.type !== 'enum',
      }),
    ]);
    // Switching to a dropdown seeds the choices from what is already in the column.
    type.addEventListener('change', () =>
      update({ type: type.value, values: type.value === 'enum' && !field.values.length ? c.distinct : field.values })
    );

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
      el('span', { className: 'col-name', textContent: c.name || '(unnamed column)' }),
      el('span', {
        className: 'muted small',
        textContent: c.imported
          ? `${c.distinct.length}${c.tooMany ? '+' : ''} distinct` + (c.blanks ? `, ${c.blanks} blank` : '')
          : 'added here',
      }),
      type,
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

    return el(
      'div',
      { className: 'col-row' + (field.type === 'enum' ? ' open' : '') },
      field.type === 'enum' ? [head, ...valueEditor(c.name, field, all)] : [head]
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
        type: newType.value,
        values: newType.value === 'enum' ? newValues.value.split(',') : [],
        custom: true,
        show: true,
      },
    });
  };
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addColumn()));

  $('#column-config').replaceChildren(
    ...rows,
    el('h4', { className: 'section', textContent: 'Add a column' }),
    el('div', { className: 'add-column' }, [newName, newType, newValues, button('Add column', 'primary', addColumn)]),
    el('p', {
      className: 'muted small',
      textContent:
        'Every column is editable free text unless you make it a dropdown. A playbook step can fill any of them in ' +
        'automatically — pick the column on the step. Removing a choice only takes it out of the dropdown; rows ' +
        'already set to it keep their value.',
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

/** Ask before a big run, projecting the bill from this list's own history. */
function confirmRun(rows, what) {
  const done = state.cost?.byList.find((l) => l.id === state.listId);
  const per = done?.calls && state.investors.stepCount ? done.cost / (done.calls / state.investors.stepCount) : null;
  const estimate = per
    ? `\n\nRoughly ${money(per * rows.length)} at this list's average of ${money(per)} per row.`
    : '';
  return confirm(`Run the playbook on ${rows.length} ${what}?${estimate}`);
}

$('#run-all').addEventListener('click', () => {
  const rows = visibleRows();
  if (!rows.length) return;
  const filtered = isFiltered();
  if (!confirmRun(rows, filtered ? 'filtered row(s)' : 'row(s)')) return;
  // Send ids when filtered so the server runs exactly what is on screen.
  run(filtered ? { investorIds: rows.map((r) => r.__id) } : { scope: 'all' });
});

$('#run-unanswered').addEventListener('click', () => {
  const rows = visibleRows().filter((r) => r.__done < state.investors.stepCount);
  if (!rows.length) return;
  if (!confirmRun(rows, isFiltered() ? 'filtered row(s) with missing answers' : 'row(s) with missing answers')) return;
  run(isFiltered() ? { investorIds: rows.map((r) => r.__id) } : { scope: 'unanswered' });
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
    if (state.running !== !!s.running) {
      state.running = !!s.running;
      renderRunButtons(visibleRows());
    }

    if (s.running) {
      pill.className = 'pill running';
      pill.textContent =
        `${s.listName}: ${s.completed}/${s.total} · ${money(s.cost || 0)} · ` +
        (s.current?.join(', ') || 'working…');
    } else if (s.status) {
      pill.className = 'pill done';
      pill.textContent =
        `${s.status} — ${s.completed}/${s.total}, ${money(s.cost || 0)}` +
        (s.stepErrors ? `, ${s.stepErrors} step error${s.stepErrors === 1 ? '' : 's'}` : '');
    } else {
      pill.className = 'pill idle';
      pill.textContent = 'Idle';
    }

    if (s.log) {
      const log = $('#log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(...s.log.map((l) => el('div', { textContent: `${l.t.slice(11, 19)}  ${l.msg}` })));
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    // Refresh whatever is on screen while a run touches this list.
    if ((s.running || wasRunning) && s.listId) {
      await loadCost();
      if (s.listId === state.listId) {
        await loadInvestors();
        if (state.selected) await selectInvestor(state.selected);
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
    ...(state.investors.columns || []).map((name) =>
      el('option', {
        value: name,
        textContent: `${name} (${fieldFor(name)?.type === 'enum' ? 'dropdown' : 'text'})`,
        selected: name === step.writeTo,
      })
    ),
  ]);
  if (step.writeTo && !fieldFor(step.writeTo)) {
    sel.append(el('option', { value: step.writeTo, textContent: `${step.writeTo} (missing)`, selected: true }));
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

// --------------------------------------------------------------------- boot

await route();
poll();
