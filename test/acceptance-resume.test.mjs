import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';

const HERE = import.meta.dirname;
const ROOT = path.dirname(HERE);
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'challenge-easy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('acceptance 6: crash + resume — swarm completes after a hard kill', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-'));
  const child = spawn(process.execPath, [
    path.join(ROOT, 'bin', 'shingun.mjs'), 'run', FIXTURE,
    '--profile', 'low-power', '--workspace', ws
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

  // Hard kill with tree semantics (taskkill on Windows; SIGKILL is POSIX).
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      tk.on('close', resolve);
      tk.on('error', resolve);
    });
  } else {
    child.kill('SIGKILL');
  }
  // Wait for the original process (and its tree) to be fully gone.
  await Promise.race([
    new Promise((resolve) => child.on('close', resolve)),
    sleep(3000)
  ]);
  await sleep(800); // let orphaned tool children notice the dead parent

  // Resume: a fresh process-equivalent orchestrator over the same store.
  const { config, env } = await loadConfig({ file: path.join(ROOT, 'config.json'), profile: 'low-power' });
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
