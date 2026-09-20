import {
  read,
  write,
  listFile,
  playbookFile,
  readRowsMerged,
  readSchema,
  findField,
  writeCell,
} from './store.js';
import { makeClient, askLLM, chooseValue } from './llm.js';
import { costOf, addUsage } from './pricing.js';

/**
 * Fill {{Column Name}} from the investor row and {{steps.key}} (or
 * {{step.key}}) from answers produced earlier in this run.
 * Column matching is case/whitespace insensitive so "{{lead investor}}" works.
 */
export function renderTemplate(tpl, row, priorByKey) {
  const missing = [];
  const lookup = new Map();
  for (const [k, v] of Object.entries(row)) lookup.set(norm(k), v);

  const out = String(tpl ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, rawName) => {
    const name = rawName.trim();
    const stepRef = /^steps?\.(.+)$/i.exec(name);
    if (stepRef) {
      const key = norm(stepRef[1]);
      if (Object.prototype.hasOwnProperty.call(priorByKey, key)) return priorByKey[key];
      missing.push(name);
      return '';
    }
    const v = lookup.get(norm(name));
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    return v;
  });

  return { text: out, missing };
}

function norm(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function slugify(s) {
  return (
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'step'
  );
}

/** The saved playbook the list is attached to. */
function resolvePlaybook(listId) {
  const list = read('lists', []).find((l) => l.id === listId);
  if (!list?.playbookId) return { id: null, steps: [] };
  return read(playbookFile(list.playbookId), { steps: [] });
}

// ---------------------------------------------------------------- job state

let job = null;

export function jobStatus() {
  if (!job) return { running: false };
  return {
    running: job.status === 'running',
    listId: job.listId,
    listName: job.listName,
    status: job.status,
    total: job.total,
    completed: job.completed,
    stepErrors: job.stepErrors,
    cost: job.cost,
    costUnknown: job.costUnknown,
    avgMs: job.rowsTimed ? Math.round(job.rowMsTotal / job.rowsTimed) : null,
    etaMs:
      job.rowsTimed && job.status === 'running'
        ? Math.round(((job.total - job.completed) * (job.rowMsTotal / job.rowsTimed)) / job.concurrency)
        : null,
    // Row ids, so the table can mark what is in flight and what is queued.
    currentIds: job.current.map((c) => c.id),
    pendingIds: [...job.pending],
    current: job.current.map((c) => c.label),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log.slice(-200),
  };
}

export function cancelJob() {
  if (job && job.status === 'running') {
    job.status = 'cancelling';
    job.controller.abort();
    return true;
  }
  return false;
}

/** Durations read at a glance: "45s", "3m 20s", "1h 04m". */
function humanMs(ms) {
  const total = Math.round(ms / 1000);
  if (total < 90) return `${total}s`;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function log(msg) {
  job.log.push({ t: new Date().toISOString(), msg });
  if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
}

/**
 * Run the playbook over the given investor ids. Steps run sequentially per
 * investor; investors run `concurrency` at a time.
 */
export function startRun({
  listId,
  listName,
  investorIds,
  stepIds,
  onlyMissing,
  scopeLabel,
  concurrency: concurrencyOverride,
  effort: effortOverride,
}) {
  if (job && job.status === 'running') throw new Error('A run is already in progress.');

  const settings = read('settings', {});
  const playbook = resolvePlaybook(listId);
  const investors = readRowsMerged(listId);

  let steps = playbook.steps.filter((s) => s.enabled !== false);
  if (stepIds && stepIds.length) {
    // Naming a step is asking for it, so a manual-only step runs here.
    steps = steps.filter((s) => stepIds.includes(s.id));
  } else {
    steps = steps.filter((s) => !s.manual);
  }
  if (!playbook.id) throw new Error('This list has no playbook attached. Pick one on the Playbook tab.');
  if (!steps.length) throw new Error('The playbook has no enabled steps to run.');

  const byId = new Map(investors.rows.map((r) => [r.__id, r]));
  const targets = investorIds.map((id) => byId.get(id)).filter(Boolean);
  if (!targets.length) throw new Error('No matching investors to run.');

  // Per-run overrides sit on top of the saved settings without changing them.
  const runSettings = { ...settings };
  if (effortOverride) runSettings.effort = effortOverride;

  const client = makeClient(settings.apiKey);

  job = {
    listId,
    listName,
    status: 'running',
    total: targets.length,
    completed: 0,
    stepErrors: 0,
    cost: 0,
    costUnknown: false,
    // How rows were chosen ('selected', 'filtered', or ''), for the log.
    scopeLabel: (scopeLabel || '').trim(),
    started: 0,
    // Per-row timings, for the running average and the estimate of what is left.
    rowMsTotal: 0,
    rowsTimed: 0,
    concurrency: 1,
    current: [],
    pending: new Set(targets.map((r) => r.__id)),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    controller: new AbortController(),
  };
  const what = job.scopeLabel ? `${job.scopeLabel} row` : 'row';

  const concurrency = Math.max(1, Math.min(8, Number(concurrencyOverride || settings.concurrency) || 1));
  job.concurrency = concurrency;
  log(
    `Starting run: ${targets.length} ${what}${targets.length === 1 ? '' : 's'} × ` +
      `${steps.length} step${steps.length === 1 ? '' : 's'}` +
      (onlyMissing ? ', filling gaps only' : '') +
      ` — ${concurrency} at a time, ${runSettings.model} at ${runSettings.effort} effort.`
  );

  const queue = targets.slice();

  const worker = async () => {
    while (queue.length) {
      if (job.controller.signal.aborted) return;
      const row = queue.shift();
      const name = row[investors.columns[0]] || row.__id;
      // Position in the run, fixed when the row is picked up, so each line
      // says where in the set it belongs even with several running at once.
      const position = ++job.started;
      const label = `${position}/${job.total}${job.scopeLabel ? ' ' + job.scopeLabel : ''}`;
      job.pending.delete(row.__id);
      job.current = [...job.current, { id: row.__id, label: name }];
      log(`[${label}] ${name}`);
      const startedAt = Date.now();
      try {
        await runOne({ listId, client, settings: runSettings, playbook, steps, row, label, name, onlyMissing });
      } catch (err) {
        if (job.controller.signal.aborted) return;
        job.stepErrors++;
        log(`[${label}] ✗ ${name}: ${err.message}`);
      }
      job.current = job.current.filter((c) => c.id !== row.__id);
      job.completed++;

      // Running average, and what it implies for the rows still queued.
      const ms = Date.now() - startedAt;
      job.rowMsTotal += ms;
      job.rowsTimed++;
      const avg = job.rowMsTotal / job.rowsTimed;
      const left = job.total - job.completed;
      const eta = left ? ` · ~${humanMs((left * avg) / job.concurrency)} left` : '';
      log(`[${label}] ${name} done in ${humanMs(ms)} · average ${humanMs(avg)} per investor${eta}`);
    }
  };

  const run = Promise.all(Array.from({ length: concurrency }, worker))
    .then(() => {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'done';
      const elapsed = Date.now() - new Date(job.startedAt).getTime();
      const avg = job.rowsTimed ? ` Average ${humanMs(job.rowMsTotal / job.rowsTimed)} per investor.` : '';
      log(
        `${job.status === 'cancelled' ? 'Run cancelled' : 'Run finished'} — ` +
          `${job.completed}/${job.total} in ${humanMs(elapsed)}.${avg}`
      );
    })
    .catch((err) => {
      job.status = 'error';
      log(`Run aborted: ${err.message}`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      job.current = [];
      job.pending.clear();
    });

  // Fire and forget; progress is polled via /api/run/status.
  void run;
  return jobStatus();
}

async function runOne({ listId, client, settings, playbook, steps, row, label, name, onlyMissing }) {
  const line = (msg) => log(`[${label}] ${msg}`);
  const schema = readSchema(listId);
  const answers = read(listFile(listId, 'answers'), {});
  const priorByKey = {};
  for (const [key, val] of Object.entries(answers[row.__id]?.byKey || {})) priorByKey[key] = val;

  const messages = [];
  const answered = []; // step ids already in the thread, for later inspection
  const signal = job.controller.signal;

  for (const step of steps) {
    if (signal.aborted) throw new Error('Cancelled');

    // Filling gaps: a step that already has an answer is not re-asked, but it
    // is replayed into the thread so later steps still see it.
    const existing = answers[row.__id]?.steps?.[step.id];
    if (onlyMissing && existing?.text) {
      if (playbook.mode !== 'independent') {
        messages.push({ role: 'user', content: existing.prompt });
        messages.push({ role: 'assistant', content: existing.text });
      }
      priorByKey[slugify(step.key || step.name)] = existing.text;
      answered.push(step.id);
      continue;
    }

    const { text: prompt, missing } = renderTemplate(step.prompt, row, priorByKey);
    line(`→ ${name} · ${step.name}`);

    const record = {
      stepId: step.id,
      stepName: step.name,
      prompt,
      missing,
      updatedAt: new Date().toISOString(),
      model: settings.model,
      webSearch: !!step.webSearch,
      mode: playbook.mode === 'independent' ? 'independent' : 'conversation',
      // Steps whose prompt and answer were already in the thread when this ran.
      context: playbook.mode === 'independent' ? [] : [...answered],
    };

    const conversation = playbook.mode !== 'independent';
    const thread = conversation ? messages : [];
    thread.push({ role: 'user', content: prompt });

    try {
      const result = await askLLM(client, {
        system: playbook.system,
        messages: thread,
        settings,
        webSearch: !!step.webSearch,
        signal,
      });

      Object.assign(record, {
        text: result.text,
        citations: result.citations,
        truncated: result.truncated,
        error: null,
      });
      bill(record, settings.model, result.usage);
      record.searches = result.searches;
      record.resumes = result.resumes;
      priorByKey[slugify(step.key || step.name)] = result.text;
      answered.push(step.id);
      line(`✓ ${name} · ${step.name} (${result.usage.output} out tokens)`);

      // Fill a column from this answer, if the step is wired to one.
      const field = step.writeTo && findField(schema, step.writeTo);
      if (step.writeTo && !field) {
        record.writeError = `Column "${step.writeTo}" no longer exists.`;
        line(`⚠ ${name} · ${step.name}: ${record.writeError}`);
      } else if (field && !field.editable) {
        record.writeError = `Column "${step.writeTo}" is read-only. Make it editable to let a step fill it.`;
        line(`⚠ ${name} · ${step.name}: ${record.writeError}`);
      } else if (field) {
        const column = step.writeTo; // the field map is keyed by name
        try {
          let value;
          if (field.type === 'enum') {
            if (!field.values.length) throw new Error(`Column "${column}" has no allowed values.`);
            const picked = await chooseValue(client, {
              system: playbook.system,
              messages: thread,
              settings,
              column,
              values: field.values,
              signal,
            });
            value = picked.value;
            bill(record, settings.model, picked.usage);
          } else {
            value = result.text;
          }
          writeCell(listId, row.__id, column, value);
          row[column] = value;
          record.wroteTo = { column, value };
          line(`⤷ ${name} · ${column} = ${value.length > 60 ? value.slice(0, 60) + '…' : value}`);
        } catch (err) {
          if (signal.aborted) throw new Error('Cancelled');
          record.writeError = err.message;
          job.stepErrors++;
          line(`✗ ${name} · ${column}: ${err.message}`);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new Error('Cancelled');
      // Drop the unanswered user turn so the thread stays alternating.
      if (conversation) thread.pop();
      record.text = '';
      record.error = err.message;
      job.stepErrors++;
      line(`✗ ${name} · ${step.name}: ${err.message}`);
    }

    saveAnswer(listId, row.__id, step, record, priorByKey);
  }
}

/** Fold one call's usage and dollar cost into the step's record and the job. */
function bill(record, model, usage) {
  record.usage = addUsage(record.usage, usage);
  const cost = costOf(model, usage);
  if (cost === null) {
    record.costUnknown = true;
    job.costUnknown = true;
  } else {
    record.cost = (record.cost || 0) + cost;
    job.cost += cost;
  }
}

function saveAnswer(listId, investorId, step, record, priorByKey) {
  const key = listFile(listId, 'answers');
  const answers = read(key, {});
  const entry = (answers[investorId] ||= { steps: {}, byKey: {} });
  entry.steps[step.id] = record;
  entry.byKey = { ...entry.byKey, ...priorByKey };
  entry.updatedAt = record.updatedAt;
  write(key, answers);
}
