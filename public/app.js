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

const state = {
  lists: [],
  listId: null,
  list: null,
  investors: { columns: [], rows: [], stepCount: 0 },
  playbook: null,
  selected: null,
  filter: '',
};

// ------------------------------------------------------------------ routing
// #/lists | #/list/<id>/investors | #/list/<id>/playbook | #/settings

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'lists').split('/');
  if (parts[0] === 'list' && parts[1]) return { view: parts[2] || 'investors', listId: parts[1] };
  return { view: parts[0] === 'settings' ? 'settings' : 'lists', listId: null };
}

async function route() {
  const { view, listId } = parseHash();

  if (listId && listId !== state.listId) {
    state.listId = listId;
    state.selected = null;
    state.filter = '';
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
  $('#export').href = `/api/lists/${listId}/export.csv`;

  if (view === 'lists') await loadLists();
  if (view === 'playbook') {
    renderTokens();
    await fillCopyMenu();
  }
  if (view === 'settings') await loadSettings();
}

window.addEventListener('hashchange', route);

// -------------------------------------------------------------------- lists

async function loadLists() {
  state.lists = await api('/api/lists');
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
            `${l.rowCount} rows · ${l.columns.length} columns · ${l.stepCount} playbook step${l.stepCount === 1 ? '' : 's'}` +
            (l.source ? ` · ${l.source}` : ''),
        }),
        el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })),
        el('div', {
          className: 'muted small',
          textContent: l.stepCount
            ? `${l.answered} of ${l.rowCount} fully researched` +
              (l.errors ? ` · ${l.errors} with errors` : '') +
              (l.lastRun ? ` · last run ${new Date(l.lastRun).toLocaleString()}` : '')
            : 'No playbook steps yet',
        }),
        el('div', { className: 'card-actions' }, [
          el('a', { className: 'btn primary', href: `#/list/${l.id}/investors`, textContent: 'Research' }),
          el('a', { className: 'btn', href: `#/list/${l.id}/playbook`, textContent: 'Playbook' }),
          el('a', { className: 'btn', href: `/api/lists/${l.id}/export.csv`, textContent: 'Export' }),
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
  renderTable();
}

function visibleRows() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.investors.rows;
  return state.investors.rows.filter((r) =>
    state.investors.columns.some((c) => String(r[c] ?? '').toLowerCase().includes(q))
  );
}

function renderTable() {
  const { columns, stepCount = 0 } = state.investors;
  const shown = columns.slice(0, 4);
  $('#investor-table thead').replaceChildren(
    el('tr', {}, [...shown.map((c) => el('th', { textContent: c })), el('th', { textContent: 'Answers' })])
  );

  const rows = visibleRows();
  $('#count').textContent = `${rows.length} of ${state.investors.rows.length} rows`;

  $('#investor-table tbody').replaceChildren(
    ...rows.map((r) => {
      const status = el('span', {
        className: 'badge ' + (r.__errors ? 'err' : stepCount && r.__done >= stepCount ? 'full' : ''),
        textContent: stepCount ? `${r.__done}/${stepCount}` : '—',
      });
      const tr = el('tr', { className: r.__id === state.selected ? 'selected' : '' }, [
        ...shown.map((c) => el('td', { textContent: r[c] ?? '', title: r[c] ?? '' })),
        el('td', {}, status),
      ]);
      tr.addEventListener('click', () => selectInvestor(r.__id));
      return tr;
    })
  );
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
    const body = a?.error
      ? el('div', { className: 'body error', textContent: '⚠ ' + a.error })
      : a?.text
      ? el('div', { className: 'body', textContent: a.text })
      : el('div', { className: 'body empty', textContent: 'No answer yet.' });

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
    if (a?.prompt) {
      parts.push(el('details', {}, [el('summary', { textContent: 'Prompt sent' }), el('pre', { textContent: a.prompt })]));
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

function button(text, cls, onClick) {
  const b = el('button', { textContent: text, className: cls });
  b.addEventListener('click', onClick);
  return b;
}

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderTable();
});

// ---------------------------------------------------------------------- run

async function run(body) {
  try {
    await post(`/api/lists/${state.listId}/run`, body);
    poll();
  } catch (err) {
    alert(err.message);
  }
}

$('#run-all').addEventListener('click', () => {
  if (confirm(`Run the playbook on all ${state.investors.rows.length} rows?`)) run({ scope: 'all' });
});
$('#run-unanswered').addEventListener('click', () => run({ scope: 'unanswered' }));
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

    if (s.running) {
      pill.className = 'pill running';
      pill.textContent = `${s.listName}: ${s.completed}/${s.total} · ${s.current?.join(', ') || 'working…'}`;
    } else if (s.status) {
      pill.className = 'pill done';
      pill.textContent = `${s.status} — ${s.completed}/${s.total}${s.stepErrors ? `, ${s.stepErrors} step error${s.stepErrors === 1 ? '' : 's'}` : ''}`;
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

function renderSteps() {
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
  state.playbook.steps.push({
    name: `Step ${state.playbook.steps.length + 1}`,
    prompt: '',
    webSearch: true,
    enabled: true,
  });
  renderSteps();
});

$('#save-playbook').addEventListener('click', async () => {
  state.playbook.system = $('#system').value;
  state.playbook.mode = $('#mode').value;
  state.playbook = await api(`/api/lists/${state.listId}/playbook`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.playbook),
  });
  renderSteps();
  renderTokens();
  $('#playbook-status').textContent = 'Saved ' + new Date().toLocaleTimeString();
  await loadInvestors();
});

async function fillCopyMenu() {
  const lists = await api('/api/lists');
  const sel = $('#copy-playbook');
  sel.replaceChildren(
    el('option', { value: '', textContent: 'Copy playbook from…' }),
    ...lists
      .filter((l) => l.id !== state.listId && l.stepCount)
      .map((l) => el('option', { value: l.id, textContent: `${l.name} (${l.stepCount} steps)` }))
  );
}

$('#copy-playbook').addEventListener('change', async (e) => {
  const sourceId = e.target.value;
  e.target.value = '';
  if (!sourceId) return;
  if (!confirm('Replace this list’s playbook with that one? Existing answers are kept but will no longer line up with the new steps.')) return;
  state.playbook = await post(`/api/lists/${state.listId}/playbook/copy-from/${sourceId}`);
  $('#system').value = state.playbook.system || '';
  $('#mode').value = state.playbook.mode || 'conversation';
  renderSteps();
  renderTokens();
  await loadInvestors();
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
