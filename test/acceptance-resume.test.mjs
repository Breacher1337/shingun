import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'challenge-easy');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('acceptance 6: crash + resume — swarm completes after a hard kill', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-'));
  const child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'shingun.mjs'), 'run', FIXTURE,
    '--profile', 'low-power', '--config', TEST_CONFIG, '--workspace', ws
  ], { cwd: ROOT, stdio: 'ignore' });

  // Watch the events dir until the FIRST durable event lands, then kill hard:
  // the earliest possible kill point — pre-triage, pre-solve — is exactly
  // the crash window resume must recover from.
  const chRoot = path.join(ws, 'challenges');
  let sawFirstEvent = false;
  for (let i = 0; i < 400 && child.exitCode == null && !sawFirstEvent; i++) {
    await sleep(25);
    let cids = [];
    try { cids = await fs.readdir(chRoot); } catch { continue; }
    for (const cid of cids) {
      const evDir = path.join(chRoot, cid, 'events');
      let files = [];
      try { files = await fs.readdir(evDir); } catch { continue; }
      for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
        try {
          const text = await fs.readFile(path.join(evDir, f), 'utf8');
          if (text.includes('"challenge.ingested"') || text.includes('"worker.status"')) {
            sawFirstEvent = true;
          }
        } catch { /* mid-append */ }
      }
    }
  }
  assert.ok(sawFirstEvent, 'swarm started before the crash');

  // Kill hard and kill NOW. At this point the child has zero live tool
  // grandchildren (the spawn wave starts post-triage), so a direct
  // TerminateProcess/SIGKILL on the root is tree-complete. Spawning
  // taskkill as an intermediary costs ~300ms on Windows — this whole mock
  // swarm solves in ~0.7s, so an indirect kill can lose the race and turn
  // the store terminal before resume sees it. Kill inline; follow up with
  // taskkill /T best-effort for any straggler grandchildren.
  child.kill('SIGKILL');
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      tk.on('close', resolve);
      tk.on('error', resolve);
    });
  }
  // Wait for the original process (and its tree) to be fully gone.
  await Promise.race([
    new Promise((resolve) => child.on('close', resolve)),
    sleep(3000)
  ]);
  await sleep(800); // let orphaned tool children notice the dead parent

  // Resume: a fresh process-equivalent orchestrator over the same store.
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });
  const resumed = await orch.resume();
  assert.equal(resumed.length, 1, `one swarm resumed (got ${resumed.length})`);

  // Let the respawned workers finish; wait for the store's final marker so
  // teardown never races the last post-mortem writes.
  const sid = resumed[0];
  const s = orch.swarms.get(sid);
  let sawFinal = false;
  for (let i = 0; i < 240 && !sawFinal; i++) {
    const evs = await s.store.replay();
    sawFinal = evs.some((e) => e.type === 'swarm.update' && e.data?.final === true);
    if (!sawFinal && ['solved', 'stopped', 'capped'].includes(s.status)) {
      // solved via the resume fast-path (flags already at crash): synthesize
      // the final marker locally so the loop can end.
      sawFinal = true;
    }
    if (!sawFinal) await sleep(250);
  }
  assert.equal(s.status, 'solved', `resumed swarm solved (got ${s.status})`);
  assert.ok(s.flags.length >= 1, 'flag found after resume');
  await sleep(300); // let any trailing in-flight append drain

  // Deterministic replay: two replays must derive identical state.
  const events = await s.store.replay();
  const summarize = (evs) => JSON.stringify({
    statuses: evs.filter((e) => e.type === 'worker.status').map((e) => [e.worker, e.data.status]),
    flags: evs.filter((e) => e.type === 'flag.found').map((e) => e.data.flag),
    swarmStatus: [...evs].reverse().find((e) => e.type === 'swarm.update')?.data?.status
  });
  assert.equal(summarize(events), summarize(await s.store.replay()), 'replay is deterministic');
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});

test('P1-10: resume rehydrates budget guard from usage.tick events and blocks overspend', async () => {
  const { openEventStore } = await import('../src/store.mjs');
  const { tmpWorkspace } = await import('./helpers.mjs');
  const ws = await tmpWorkspace('resume-budget-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  config.budget.perSwarmUsd = 1.00;
  const chDir = path.join(ws, 'challenges', 'ch-p110');
  await fs.mkdir(path.join(chDir, 'base'), { recursive: true });
  await fs.mkdir(path.join(chDir, 'events'), { recursive: true });
  const store = await openEventStore(path.join(chDir, 'events', 'sw-p110.jsonl'), { swarmId: 'sw-p110' });
  await store.append({ type: 'challenge.ingested', swarm: 'sw-p110', challenge: 'ch-p110', data: { sourceType: 'none', sourceValue: '' } });
  await store.append({ type: 'swarm.update', swarm: 'sw-p110', challenge: 'ch-p110', data: { status: 'running' } });
  await store.append({ type: 'worker.spawn', swarm: 'sw-p110', challenge: 'ch-p110', worker: 'w-1', data: { persona: 'hypothesis-prover' } });
  await store.append({ type: 'worker.status', swarm: 'sw-p110', challenge: 'ch-p110', worker: 'w-1', data: { status: 'reasoning' } });
  // mock pricePerMTok is { in: 0.70, out: 2.10 }; 500k in ($0.35) + 300k out ($0.63) = $0.98
  await store.append({ type: 'usage.tick', swarm: 'sw-p110', challenge: 'ch-p110', worker: 'w-1', data: { role: 'worker', provider: 'mock', tokensIn: 500_000, tokensOut: 300_000 } });

  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });
  const resumed = await orch.resume();
  assert.deepEqual(resumed, ['sw-p110']);
  const s = orch.swarms.get('sw-p110');
  const pre = s.capGuard.preflight({ estTokens: 50_000, priceIn: 0.70, priceOut: 2.10 }); // +$0.07 > $1.00
  assert.equal(pre.ok, false, 'resumed capGuard must block spend exceeding original cap');
  const evs = await s.store.replay();
  assert.ok(evs.some((e) => e.type === 'budget.resumed' && Math.abs(e.data.usd - 0.98) < 1e-6 && e.data.tokens === 800_000));
  await orch.stop('sw-p110', 'test-teardown').catch(() => {});
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
