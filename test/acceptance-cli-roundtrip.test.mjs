import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runCli, tmpWorkspace, NODE, BIN, FIXTURE } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The relay commands dial `config.port`, so serve and CLI must share one
 * config file — the operator `--config` flag exists for exactly this. A
 * random high port keeps the test decoupled from anything else on the box
 * (a dashboard `serve` on the default 8787 included).
 */
async function writePortConfig(ws) {
  const port = 28000 + Math.floor(Math.random() * 2001);
  const file = path.join(ws, 'relay-config.json');
  await fs.writeFile(file, JSON.stringify({ port }, null, 2) + '\n', 'utf8');
  return { port, file };
}

/** Boot a serve child on a chosen fixed port (shared with relayed CLI calls). */
async function bootServe(ws, port, configFile) {
  const child = spawn(NODE, [BIN, 'serve', '--config', configFile, '--workspace', ws], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const url = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = /dashboard: (\S+)/.exec(out);
      if (m) { clearInterval(timer); resolve(m[1]); }
      else if (Date.now() - t0 > 25000) {
        clearInterval(timer);
        reject(new Error(`serve did not boot: ${out.slice(0, 400)}`));
      }
    }, 100);
  });
  const token = new URL(url).searchParams.get('token');
  return { child, base: new URL(url).origin, token, url };
}

async function api(base, token, routePath, { method = 'GET', body } = {}) {
  const res = await fetch(base + routePath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function stopServe(child) {
  child.kill('SIGKILL');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    child.once('close', () => { clearTimeout(t); resolve(); });
  });
}

test('acceptance 3b: master + steer round-trip through a live serve process', async () => {
  const ws = await tmpWorkspace('relay-');
  const { port, file: configFile } = await writePortConfig(ws);
  let serve = null;
  try {
    serve = await bootServe(ws, port, configFile);

    // A mock swarm over HTTP, then relay into it from fresh CLI processes
    // (the exact round-trip a serve-centric workflow needs).
    const ch = await api(serve.base, serve.token, '/api/challenges', {
      method: 'POST', body: { source: 'path', value: FIXTURE }
    });
    const sw = await api(serve.base, serve.token, `/api/challenges/${ch.data.challengeId}/swarm`, {
      method: 'POST', body: { workers: 4 }
    });
    const sid = sw.data.swarmId;
    assert.ok(sid, `swarm started: ${JSON.stringify(sw.data)}`);

    // master relay must land while the swarm is live: CLI boot (~300ms) sits
    // well inside the spawn wave (worktree adds). Retry into fresh swarms
    // on the rare slow-boot miss.
    let sawChat = false;
    for (let attempt = 0; attempt < 3 && !sawChat; attempt++) {
      const master = await runCli(['master', sid, 'Give me a status report.', '--config', configFile, '--workspace', ws], { timeoutMs: 60000 });
      assert.equal(master.code, 0, `master relay exit: ${master.stderr.slice(0, 300)}`);
      assert.deepEqual(master.events[0], { ok: true, via: 'serve' }, 'relay answered over HTTP, not in-process');
      // master.chat replies stream as events into the serve process store.
      for (let i = 0; i < 40; i++) {
        const snap = await api(serve.base, serve.token, `/api/swarms/${sid}`);
        if ((snap.data.masterChat ?? []).length >= 2) { sawChat = true; break; }
        await sleep(150);
      }
      if (!sawChat) await sleep(500);
    }
    assert.ok(sawChat, 'master.chat persisted the relayed directive + reply');

    // Terminal or not, the steer note is queued for the worker record;
    // workers register a beat after the spawn wave begins, so poll for one.
    let wid = null;
    let challengeId = null;
    for (let i = 0; i < 60 && !wid; i++) {
      const snap = await api(serve.base, serve.token, `/api/swarms/${sid}`);
      challengeId = snap.data.challengeId;
      wid = (snap.data.workers ?? []).find((w) => w.id && w.id !== 'unknown')?.id ?? null;
      if (!wid) await sleep(150);
    }
    assert.ok(wid, 'a worker exists to steer');
    const steer = await runCli(['steer', sid, wid, 'prioritize the README', '--config', configFile, '--workspace', ws], { timeoutMs: 60000 });
    assert.equal(steer.code, 0, `steer relay exit: ${steer.stderr.slice(0, 300)}`);
    assert.equal(steer.events[0].queued, true, 'steer queued');
    assert.equal(steer.events[0].via, 'serve', 'steer went through the live server');

    // Graceful stop over the API, then teardown the serve child.
    const stop = await api(serve.base, serve.token, `/api/swarms/${sid}/stop`, { method: 'POST', body: {} });
    assert.equal(stop.status, 200, 'swarm stopped cleanly');
  } finally {
    if (serve) await stopServe(serve.child);
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance 3b-3: a steered note is injected at the next step boundary', async () => {
  const { loadConfig, resolveWorkspace } = await import('../src/config.mjs');
  const { createBus } = await import('../src/bus.mjs');
  const { createOrchestrator } = await import('../src/orchestrator.mjs');
  const ws = await tmpWorkspace('steer-engine-');
  const { config, env } = await loadConfig({ file: path.join(ROOT, 'config.json') });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });

  const { ingestChallenge } = await import('../src/ingest.mjs');
  const ing = await ingestChallenge({
    source: 'path', value: FIXTURE, challengesDir: path.join(ws, 'challenges')
  });
  const { swarmId } = await orch.startSwarm({
    challenge: {
      id: ing.challengeId, sourceType: 'path', sourceValue: '(test)',
      baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles,
      flagFormatRegex: null, categoryHint: null
    },
    opts: { workers: 2 }
  });
  const s = orch.swarms.get(swarmId);

  // Steer as soon as the first worker registers — well before its first
  // provider step, so the note is guaranteed to drain at a step boundary.
  let wid = null;
  for (let i = 0; i < 200 && !wid; i++) {
    const first = [...s.workers.values()][0];
    if (first) wid = first.id;
    else await sleep(20);
  }
  assert.ok(wid, 'a worker registered');
  const out = await orch.steerWorker(swarmId, wid, 'prioritize the README over brute force');
  assert.deepEqual(out, { queued: true });

  await Promise.race([s.done, sleep(20000)]);
  const transcript = await fs.readFile(
    path.join(ws, 'challenges', ing.challengeId, 'transcripts', `${wid}.jsonl`), 'utf8'
  ).catch(() => '');
  assert.ok(
    transcript.includes('Operator steering note: prioritize the README over brute force'),
    'the queued note reached the worker transcript at a step boundary'
  );

  await orch.stop(swarmId, 'test-teardown').catch(() => {});
  for (let i = 0; i < 200; i++) {
    if ([...s.workers.values()].every((w) => w.closed || w.isReservation)) break;
    await sleep(25);
  }
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});

test('acceptance 3b-2: relay degrades cleanly when no serve process is live', async () => {
  const ws = await tmpWorkspace('norelay-');
  const { file: configFile } = await writePortConfig(ws);
  try {
    // Nothing serves this port and nothing ever will: the CLI must fail with
    // a clear serve_unreachable instead of pretending to steer in-process.
    const steer = await runCli(['steer', 'sw-none', 'w-none', 'note', '--config', configFile, '--workspace', ws], { timeoutMs: 60000 });
    assert.notEqual(steer.code, 0, 'relay refused without a live serve');
    assert.match(steer.stderr, /no shingun serve process/i);
    const master = await runCli(['master', 'sw-none', 'hello', '--config', configFile, '--workspace', ws], { timeoutMs: 60000 });
    assert.notEqual(master.code, 0);
    assert.match(master.stderr, /no shingun serve process|no running serve/i);
  } finally {
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
