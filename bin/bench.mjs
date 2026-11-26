#!/usr/bin/env node
/**
 * shingun-bench — sketch benchmark runner (zero deps, no build step).
 *
 * Drives one `shingun run` process per (variant × challenge), parses the
 * JSONL event stream it prints on stdout, and writes:
 *
 *   <out>/events/<variant>__<challenge>.jsonl   raw event log per run
 *   <out>/results.csv                           one row per run
 *   <out>/summary.md                            per-variant comparison table
 *
 * A "variant" is a named { budgetUsd, workers, configPatch, timeoutMs } —
 * its configPatch is deep-merged over the base config and written to disk,
 * so A/B isolation happens purely through --config / --workspace.
 *
 * Usage:
 *   bin/bench.mjs <manifest.json> [--out DIR] [--concurrency N] [--filter SUBSTR]
 *
 * Manifest shape (paths relative to the manifest file):
 *   {
 *     "name": "pilot",
 *     "baseConfigFile": "config.json",
 *     "variants": [
 *       { "name": "A-personas", "workers": 4, "budgetUsd": 0.25,
 *         "timeoutMs": 900000,
 *         "configPatch": { "roles": { "worker": { "provider": "mock" } } } }
 *     ],
 *     "challenges": [
 *       { "id": "sqli-lab", "path": "examples/sqli-lab",
 *         "category": "misc", "flagFormat": "shingun\\{[^}]*\\}",
 *         "expect": "shingun{...}" }
 *     ]
 *   }
 *
 * SKETCH SCOPE: only config-level A/B for now. Code-level variants (e.g.
 * "no personas", "no sibling digest") need a shingun-side knob first.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(HERE, 'bin', 'shingun.mjs');
const KILL_GRACE_MS = 10_000;

/* ---------------------------------- util --------------------------------- */

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over;
  // A patch can deepen below a leaf (or absent key) in the base config.
  if (base === null || typeof base !== 'object' || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v === undefined ? base[k] : deepMerge(base[k], v);
  return out;
}

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '_');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function usage(code = 1) {
  process.stdout.write(`shingun-bench (sketch)

Usage:
  bin/bench.mjs <manifest.json> [--out DIR] [--concurrency N] [--filter SUBSTR]

Outputs (under --out, default ./bench-out/<name>-<timestamp>):
  events/<variant>__<challenge>.jsonl  raw event stream per run
  results.csv                          one row per run
  summary.md                           variant comparison table
`);
  process.exit(code);
}

/* -------------------------------- metrics -------------------------------- */

/** Reduce a run's raw shingun event stream into one result record. */
function reduceEvents(events, { startMs, challenge, variant }) {
  const r = {
    variant: variant.name,
    challengeId: challenge.id,
    solved: false,
    flagCorrect: false,
    flags: [],
    finalStatus: null,
    firstFlagSec: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    steps: 0,
    workersSpawned: 0,
    workersPruned: 0,
    budgetCapped: 0,
    postmortemPath: null
  };
  // worker.progress is cumulative per worker — keep the last one each.
  const progressByWorker = new Map();

  for (const ev of events) {
    const tMs = ev.t ? Date.parse(ev.t) : null;
    const rel = tMs != null ? (tMs - startMs) / 1000 : null;
    switch (ev.type) {
      case 'flag.found':
        r.flags.push(ev.data.flag);
        if (r.firstFlagSec === null && rel !== null) r.firstFlagSec = Math.round(rel * 10) / 10;
        break;
      case 'swarm.update':
        if (ev.data.final) r.finalStatus = ev.data.status;
        break;
      case 'usage.tick':
        r.costUsd += Number(ev.data.costUsd) || 0;
        break;
      case 'worker.spawn':
        r.workersSpawned += 1;
        break;
      case 'worker.pruned':
        r.workersPruned += 1;
        break;
      case 'budget.capped':
        r.budgetCapped += 1;
        break;
      case 'worker.progress':
        progressByWorker.set(ev.worker, ev.data);
        break;
      case 'swarm.postmortem':
        r.postmortemPath = ev.data.path;
        break;
      default: break;
    }
  }

  for (const p of progressByWorker.values()) {
    r.steps += Number(p.steps) || 0;
    r.tokensIn += Number(p.tokensIn) || 0;
    r.tokensOut += Number(p.tokensOut) || 0;
  }

  r.solved = r.flags.length > 0 && r.finalStatus === 'solved';
  if (challenge.expect) {
    r.flagCorrect = r.flags.some((f) => String(f).trim() === challenge.expect);
  }
  r.costUsd = Number(r.costUsd.toFixed(5));
  return r;
}

/* --------------------------------- runner -------------------------------- */

/** Build per-variant config file; returns { configPath, timeoutMs }. */
async function materializeVariant({ runDirs, baseConfig, variant }) {
  const config = deepMerge(baseConfig, variant.configPatch ?? {});
  const configPath = path.join(runDirs, `config.${sanitize(variant.name)}.json`);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  const timeoutMs =
    variant.timeoutMs ??
    ((config?.worker?.wallClockMin ?? 30) * 60 + 120) * 1000 * 1.5;
  return { configPath, timeoutMs };
}

/**
 * One (variant × challenge) run: spawn `shingun run`, tee its JSONL event
 * stream to disk, reduce it, enforce the wall-clock timeout.
 */
function runOnce({ shingunCli, configPath, workspace, challenge, variant, eventsFile, timeoutMs: derivedTimeoutMs }) {  return new Promise((resolve) => {
    const startMs = Date.now();
    const cliArgs = [
      shingunCli, 'run', challenge.path,
      '--challenge-id', sanitize(`${challenge.id}-${variant.name}`),
      '--config', configPath,
      '--workspace', workspace,
      '--budget-usd', String(variant.budgetUsd ?? 5),
      ...(variant.workers ? ['--workers', String(variant.workers)] : []),
      ...(challenge.flagFormat ? ['--flag-format', challenge.flagFormat] : []),
      ...(challenge.category ? ['--category', challenge.category] : [])
    ];
    const child = spawn(process.execPath, cliArgs, { cwd: HERE, env: process.env });

    const record = {
      variant: variant.name,
      challengeId: challenge.id,
      solved: false, flagCorrect: false, flags: [], finalStatus: null,
      firstFlagSec: null, wallSec: null, costUsd: 0, tokensIn: 0, tokensOut: 0, steps: 0,
      workersSpawned: 0, workersPruned: 0, budgetCapped: 0, postmortemPath: null,
      exit: null, signal: null, timeout: false, error: null, eventsFile: null
    };
    const raw = [];
    let settled = false;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(graceTimer);
      Object.assign(record, extra, { wallSec: Math.round((Date.now() - startMs) / 100) / 10 });
      try { Object.assign(record, reduceEvents(raw, { startMs, challenge, variant })); }
      catch (e) { record.error = `reduce: ${e.message}`; }
      record.flags = record.flags.map((f) => String(f));
      resolve(record);
    };

    const timeoutMs = variant.timeoutMs ?? derivedTimeoutMs ?? 20 * 60_000;
    const timer = setTimeout(() => {
      record.timeout = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.();
    }, timeoutMs);
    timer.unref?.();

    let closed = false;
    const graceTimer = setInterval(() => {}, 60_000); // keeps the process alive while killing
    child.on('close', (code, signal) => { closed = true; graceTimer.unref?.(); finish({ exit: code, signal }); });
    child.on('error', (e) => { if (!closed) finish({ error: e.message }); });
    child.stdin.on('error', () => {}); // EPIPE-safe

    const onLine = (line) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        raw.push(ev);
      } catch { /* non-JSON noise (e.g. serve-banner) — ignore */ }
    };
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { buf += chunk; for (const line of buf.split('\n').slice(0, -1)) onLine(line); buf = buf.slice(buf.lastIndexOf('\n') + 1); });
    child.stderr.setEncoding('utf8');
    let errTail = '';
    child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-2000); });
    child.on('close', () => { if (errTail && !record.error) record.error = errTail.trim().split('\n').pop(); });
    child.on('close', () => {
      // Persist the raw event stream per run — the postmortem source of truth.
      fs.writeFile(eventsFile, raw.map((ev) => JSON.stringify(ev)).join('\n') + '\n', 'utf8')
        .catch(() => {});
    });
  });
}

/* ------------------------------- reporting ------------------------------- */

const CSV_COLS = ['variant', 'challengeId', 'solved', 'flagCorrect', 'finalStatus', 'firstFlagSec',
  'wallSec', 'costUsd', 'tokensIn', 'tokensOut', 'steps', 'workersSpawned', 'workersPruned',
  'budgetCapped', 'timeout', 'exit', 'error', 'postmortemPath', 'eventsFile'];

function csvRow(r) {
  return CSV_COLS.map((c) => {
    let v = c === 'eventsFile' ? (r.eventsFile ?? '') : (r[c] ?? '');
    if (Array.isArray(v)) v = v.join(' | ');
    v = String(v);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

/** Aggregate per variant: solve rate, spend efficiency, latency. */
function summarize(records) {
  const byVariant = new Map();
  for (const r of records) {
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
    byVariant.get(r.variant).push(r);
  }
  const rows = [];
  for (const [variant, rs] of [...byVariant.entries()].sort()) {
    const solved = rs.filter((r) => r.solved);
    const correct = rs.filter((r) => r.flagCorrect);
    const wall = rs.map((r) => r.wallSec).sort((a, b) => a - b);
    const pct = solved.filter((r) => r.firstFlagSec != null).map((r) => r.firstFlagSec).sort((a, b) => a - b);
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    rows.push({
      variant,
      runs: rs.length,
      solved: solved.length,
      correctFlags: correct.length,
      solveRate: (solved.length / rs.length * 100).toFixed(0) + '%',
      timeouts: rs.filter((r) => r.timeout).length,
      budgetCapped: rs.filter((r) => r.budgetCapped > 0).length,
      meanCostUsd: mean(rs.map((r) => r.costUsd)),
      costPerSolvedUsd: solved.length ? solved.reduce((a, r) => a + r.costUsd, 0) / solved.length : null,
      meanWallSec: mean(wall),
      p50FlagSec: pct.length ? pct[Math.floor((pct.length - 1) / 2)] : null,
      meanSteps: mean(rs.map((r) => r.steps))
    });
  }
  return rows;
}

function summaryMarkdown(benchName, rows) {
  const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
  const lines = [
    `# shingun-bench — ${benchName}`, '',
    '| variant | runs | solved | correct flags | solve rate | timeouts | budget-capped | mean cost | cost / solved | p50 flag | mean steps |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  ];
  for (const r of rows) {
    lines.push(`| ${r.variant} | ${r.runs} | ${r.solved} | ${r.correctFlags} | ${r.solveRate} | ${r.timeouts} | ${r.budgetCapped} | $${num(r.meanCostUsd, 3)} | $${num(r.costPerSolvedUsd, 3)} | ${num(r.p50FlagSec, 1)}s | ${num(r.meanSteps, 1)} |`);
  }
  return lines.join('\n') + '\n';
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [manifestPath] = args._;
  if (!manifestPath) usage(1);

  const cwd = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const concurrency = Number(args.concurrency) || manifest.concurrency || 2;
  const filter = typeof args.filter === 'string' ? args.filter : null;

  const baseConfig = JSON.parse(await fs.readFile(
    path.resolve(cwd, manifest.baseConfigFile ?? 'config.json'), 'utf8'));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(typeof args.out === 'string' ? args.out : path.join('.', `bench-out-${manifest.name ?? 'pilot'}-${stamp}`));
  const eventsDir = path.join(out, 'events');
  await fs.mkdir(eventsDir, { recursive: true });

  // Run matrix: (variant × challenge), paths resolved against the manifest dir.
  const jobs = [];
  for (const variant of manifest.variants ?? []) {
    for (const challenge of manifest.challenges ?? []) {
      if (filter && !`${variant.name}/${challenge.id}`.includes(filter)) continue;
      jobs.push({
        variant: { ...variant },
        challenge: {
          ...challenge,
          path: path.resolve(cwd, challenge.path)
        }
      });
    }
  }
  if (!jobs.length) { process.stderr.write('shingun-bench: no jobs matched\n'); process.exit(1); }

  process.stdout.write(`shingun-bench: ${jobs.length} run(s), concurrency ${concurrency}, out ${out}\n`);

  const records = [];
  let cursor = 0;
  async function poolWorker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const { variant, challenge } = job;
      const runDirs = path.join(out, sanitize(variant.name));
      await fs.mkdir(runDirs, { recursive: true });
      const eventsFile = path.join(eventsDir, `${sanitize(variant.name)}__${sanitize(challenge.id)}.jsonl`);

      // Fresh workspace per run → zero state bleed between A/B.
      const workspace = path.join(runDirs, 'ws', sanitize(challenge.id));
      const { configPath, timeoutMs } = await materializeVariant({ runDirs, baseConfig, variant });
      await fs.rm(workspace, { recursive: true, force: true });

      process.stdout.write(`▶ ${variant.name} / ${challenge.id}\n`);
      const record = await runOnce({ shingunCli: CLI, configPath, workspace, challenge, variant, eventsFile, timeoutMs });
      record.eventsFile = eventsFile;
      records.push(record);
      process.stdout.write(`  ${record.solved ? '✔ solved' : '✘ unsolved'} (${record.finalStatus ?? '—'}) ` +
        `cost $${record.costUsd} · ${record.wallSec}s · steps ${record.steps}${record.timeout ? ' · TIMEOUT' : ''}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, poolWorker));

  await fs.writeFile(path.join(out, 'results.csv'),
    CSV_COLS.join(',') + '\n' + records.map(csvRow).join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(out, 'summary.md'), summaryMarkdown(manifest.name ?? 'pilot', summarize(records)), 'utf8');
  process.stdout.write(`\ndone → ${path.join(out, 'summary.md')}\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`shingun-bench: ${e.message}\n${e.stack ?? ''}\n`);
  process.exit(1);
});
