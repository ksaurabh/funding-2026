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

function log(msg) {
  job.log.push({ t: new Date().toISOString(), msg });
  if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
}

/**
 * Run the playbook over the given investor ids. Steps run sequentially per
 * investor; investors run `concurrency` at a time.
 */
export function startRun({ listId, listName, investorIds, stepIds }) {
  if (job && job.status === 'running') throw new Error('A run is already in progress.');

  const settings = read('settings', {});
  const playbook = resolvePlaybook(listId);
  const investors = readRowsMerged(listId);

  let steps = playbook.steps.filter((s) => s.enabled !== false);
  if (stepIds && stepIds.length) steps = steps.filter((s) => stepIds.includes(s.id));
  if (!playbook.id) throw new Error('This list has no playbook attached. Pick one on the Playbook tab.');
  if (!steps.length) throw new Error('The playbook has no enabled steps to run.');

  const byId = new Map(investors.rows.map((r) => [r.__id, r]));
  const targets = investorIds.map((id) => byId.get(id)).filter(Boolean);
  if (!targets.length) throw new Error('No matching investors to run.');

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
    current: [],
    pending: new Set(targets.map((r) => r.__id)),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    controller: new AbortController(),
  };
  log(`Starting run: ${targets.length} investor(s) × ${steps.length} step(s).`);

  const concurrency = Math.max(1, Math.min(8, Number(settings.concurrency) || 1));
  const queue = targets.slice();

  const worker = async () => {
    while (queue.length) {
      if (job.controller.signal.aborted) return;
      const row = queue.shift();
      const label = row[investors.columns[0]] || row.__id;
      job.pending.delete(row.__id);
      job.current = [...job.current, { id: row.__id, label }];
      try {
        await runOne({ listId, client, settings, playbook, steps, row, label });
      } catch (err) {
        if (job.controller.signal.aborted) return;
        job.stepErrors++;
        log(`✗ ${label}: ${err.message}`);
      }
      job.current = job.current.filter((c) => c.id !== row.__id);
      job.completed++;
    }
  };

  const run = Promise.all(Array.from({ length: concurrency }, worker))
    .then(() => {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'done';
      log(job.status === 'cancelled' ? 'Run cancelled.' : 'Run finished.');
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

async function runOne({ listId, client, settings, playbook, steps, row, label }) {
  const schema = readSchema(listId);
  const answers = read(listFile(listId, 'answers'), {});
  const priorByKey = {};
  for (const [key, val] of Object.entries(answers[row.__id]?.byKey || {})) priorByKey[key] = val;

  const messages = [];
  const answered = []; // step ids already in the thread, for later inspection
  const signal = job.controller.signal;

  for (const step of steps) {
    if (signal.aborted) throw new Error('Cancelled');

    const { text: prompt, missing } = renderTemplate(step.prompt, row, priorByKey);
    log(`→ ${label} · ${step.name}`);

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
      log(`✓ ${label} · ${step.name} (${result.usage.output} out tokens)`);

      // Fill a column from this answer, if the step is wired to one.
      const field = step.writeTo && findField(schema, step.writeTo);
      if (step.writeTo && !field) {
        record.writeError = `Column "${step.writeTo}" no longer exists.`;
        log(`⚠ ${label} · ${step.name}: ${record.writeError}`);
      } else if (field && !field.editable) {
        record.writeError = `Column "${step.writeTo}" is read-only. Make it editable to let a step fill it.`;
        log(`⚠ ${label} · ${step.name}: ${record.writeError}`);
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
          log(`⤷ ${label} · ${column} = ${value.length > 60 ? value.slice(0, 60) + '…' : value}`);
        } catch (err) {
          if (signal.aborted) throw new Error('Cancelled');
          record.writeError = err.message;
          job.stepErrors++;
          log(`✗ ${label} · ${column}: ${err.message}`);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new Error('Cancelled');
      // Drop the unanswered user turn so the thread stays alternating.
      if (conversation) thread.pop();
      record.text = '';
      record.error = err.message;
      job.stepErrors++;
      log(`✗ ${label} · ${step.name}: ${err.message}`);
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
