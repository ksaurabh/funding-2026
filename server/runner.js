import { read, write } from './store.js';
import { makeClient, askLLM } from './llm.js';

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

// ---------------------------------------------------------------- job state

let job = null;

export function jobStatus() {
  if (!job) return { running: false };
  return {
    running: job.status === 'running',
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    current: job.current,
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
export function startRun({ investorIds, stepIds }) {
  if (job && job.status === 'running') throw new Error('A run is already in progress.');

  const settings = read('settings', {});
  const playbook = read('playbook', { steps: [] });
  const investors = read('investors', { columns: [], rows: [] });

  let steps = playbook.steps.filter((s) => s.enabled !== false);
  if (stepIds && stepIds.length) steps = steps.filter((s) => stepIds.includes(s.id));
  if (!steps.length) throw new Error('The playbook has no enabled steps to run.');

  const byId = new Map(investors.rows.map((r) => [r.__id, r]));
  const targets = investorIds.map((id) => byId.get(id)).filter(Boolean);
  if (!targets.length) throw new Error('No matching investors to run.');

  const client = makeClient(settings.apiKey);

  job = {
    status: 'running',
    total: targets.length,
    completed: 0,
    failed: 0,
    current: [],
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
      job.current = [...job.current.filter((c) => c !== label), label];
      try {
        await runOne({ client, settings, playbook, steps, row, label });
      } catch (err) {
        if (job.controller.signal.aborted) return;
        job.failed++;
        log(`✗ ${label}: ${err.message}`);
      }
      job.current = job.current.filter((c) => c !== label);
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
    });

  // Fire and forget; progress is polled via /api/run/status.
  void run;
  return jobStatus();
}

async function runOne({ client, settings, playbook, steps, row, label }) {
  const answers = read('answers', {});
  const priorByKey = {};
  for (const [key, val] of Object.entries(answers[row.__id]?.byKey || {})) priorByKey[key] = val;

  const messages = [];
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
        usage: result.usage,
        error: null,
      });
      priorByKey[slugify(step.key || step.name)] = result.text;
      log(`✓ ${label} · ${step.name} (${result.usage.output} out tokens)`);
    } catch (err) {
      if (signal.aborted) throw new Error('Cancelled');
      // Drop the unanswered user turn so the thread stays alternating.
      if (conversation) thread.pop();
      record.text = '';
      record.error = err.message;
      job.failed++;
      log(`✗ ${label} · ${step.name}: ${err.message}`);
    }

    saveAnswer(row.__id, step, record, priorByKey);
  }
}

function saveAnswer(investorId, step, record, priorByKey) {
  const answers = read('answers', {});
  const entry = (answers[investorId] ||= { steps: {}, byKey: {} });
  entry.steps[step.id] = record;
  entry.byKey = { ...entry.byKey, ...priorByKey };
  entry.updatedAt = record.updatedAt;
  write('answers', answers);
}
