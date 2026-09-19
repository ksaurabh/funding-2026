const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
};

const state = { investors: { columns: [], rows: [] }, playbook: null, selected: null, filter: '' };

// ------------------------------------------------------------------- tabs

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('hidden', v.id !== 'view-' + t.dataset.view)
    );
    if (t.dataset.view === 'playbook') renderTokens();
  })
);

// -------------------------------------------------------------- investors

async function loadInvestors() {
  state.investors = await api('/api/investors');
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
  const thead = $('#investor-table thead');
  thead.replaceChildren(
    el('tr', {}, [...shown.map((c) => el('th', { textContent: c })), el('th', { textContent: 'Answers' })])
  );

  const rows = visibleRows();
  $('#count').textContent = `${rows.length} of ${state.investors.rows.length} investors`;

  const tbody = $('#investor-table tbody');
  tbody.replaceChildren(
    ...rows.map((r) => {
      const status = el('span', {
        className:
          'badge ' + (r.__errors ? 'err' : stepCount && r.__done >= stepCount ? 'full' : ''),
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
  const data = await api('/api/investors/' + id);
  const name = data.investor[data.columns[0]];

  const head = el('div', { className: 'detail-head' }, [
    el('h2', { textContent: name }),
    el('div', {
      className: 'meta',
      textContent: data.updatedAt ? 'Last run ' + new Date(data.updatedAt).toLocaleString() : 'Never run',
    }),
    el('div', { className: 'actions' }, [
      button('Run playbook on this investor', 'primary', () => run({ investorIds: [id] })),
      button('Clear answers', 'danger', async () => {
        await api(`/api/investors/${id}/answers`, { method: 'DELETE' });
        await loadInvestors();
        selectInvestor(id);
      }),
    ]),
  ]);

  const fields = el('details', { className: 'answer' }, [
    el('summary', { textContent: 'CSV row data' }),
    el('pre', {
      textContent: data.columns.map((c) => `${c}: ${data.investor[c]}`).join('\n'),
    }),
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
        s.webSearch ? el('span', { className: 'badge', textContent: 'web' }) : '',
        a?.truncated ? el('span', { className: 'badge err', textContent: 'truncated' }) : '',
      ]),
      body,
    ];

    if (a?.citations?.length) {
      parts.push(
        el(
          'div',
          { className: 'cites' },
          [el('strong', { textContent: 'Sources' })].concat(
            a.citations.map((c) =>
              el('a', { href: c.url, target: '_blank', rel: 'noreferrer', textContent: c.title || c.url })
            )
          )
        )
      );
    }
    if (a?.prompt) {
      parts.push(
        el('details', {}, [el('summary', { textContent: 'Prompt sent' }), el('pre', { textContent: a.prompt })])
      );
    }
    parts.push(
      el('div', { className: 'actions', style: 'margin-top:8px' }, [
        button('Re-run this step', '', () => run({ investorIds: [id], stepIds: [s.id] })),
      ])
    );
    return el('div', { className: 'answer' }, parts);
  });

  $('#detail').replaceChildren(head, ...answers, fields);
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

$('#import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  await api('/api/investors/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csv: await f.text(), name: f.name }),
  });
  e.target.value = '';
  state.selected = null;
  $('#detail').replaceChildren(el('p', { className: 'muted pad', textContent: 'Select an investor.' }));
  await loadInvestors();
  renderTokens();
});

// --------------------------------------------------------------------- run

async function run(body) {
  try {
    await api('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    poll();
  } catch (err) {
    alert(err.message);
  }
}

$('#run-all').addEventListener('click', () => {
  if (confirm(`Run the playbook on all ${state.investors.rows.length} investors?`)) run({ scope: 'all' });
});
$('#run-unanswered').addEventListener('click', () => run({ scope: 'unanswered' }));
$('#cancel').addEventListener('click', () => api('/api/run/cancel', { method: 'POST' }));

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
      pill.textContent = `${s.completed}/${s.total} · ${s.current?.join(', ') || 'working…'}`;
    } else if (s.status) {
      pill.className = 'pill done';
      pill.textContent = `${s.status} — ${s.completed}/${s.total}${s.failed ? `, ${s.failed} failed` : ''}`;
    } else {
      pill.className = 'pill idle';
      pill.textContent = 'Idle';
    }

    if (s.log) {
      const log = $('#log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(
        ...s.log.map((l) => el('div', { textContent: `${l.t.slice(11, 19)}  ${l.msg}` }))
      );
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    if (s.running || wasRunning) {
      await loadInvestors();
      if (state.selected) await selectInvestor(state.selected);
    }
    wasRunning = !!s.running;
  } catch {
    /* server restarting; next tick retries */
  } finally {
    polling = false;
  }
}

setInterval(poll, 2000);

// ---------------------------------------------------------------- playbook

async function loadPlaybook() {
  state.playbook = await api('/api/playbook');
  $('#system').value = state.playbook.system || '';
  $('#mode').value = state.playbook.mode || 'conversation';
  renderSteps();
}

function renderSteps() {
  const wrap = $('#steps');
  wrap.replaceChildren(
    ...state.playbook.steps.map((s, i) => {
      const node = el('div', { className: 'step' + (s.enabled === false ? ' disabled' : '') });
      const name = el('input', { type: 'text', value: s.name, placeholder: 'Step name' });
      name.addEventListener('input', () => {
        s.name = name.value;
      });

      const prompt = el('textarea', { rows: 5, value: s.prompt, placeholder: 'Ask the LLM… use {{Lead Investor}} to insert CSV values' });
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

let activePrompt = null;

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
  state.playbook = await api('/api/playbook', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.playbook),
  });
  renderSteps();
  $('#playbook-status').textContent = 'Saved ' + new Date().toLocaleTimeString();
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
      const r = await api('/api/playbook/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: tpl, investorId: state.selected }),
      });
      $('#preview').textContent =
        r.text + (r.missing.length ? `\n\n⚠ unknown variables: ${[...new Set(r.missing)].join(', ')}` : '');
    } catch (err) {
      $('#preview').textContent = err.message;
    }
  }, 250);
}

// ---------------------------------------------------------------- settings

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

// -------------------------------------------------------------------- boot

await loadInvestors();
await loadPlaybook();
await loadSettings();
renderTokens();
poll();
