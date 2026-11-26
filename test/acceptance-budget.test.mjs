import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, tmpWorkspace, FIXTURE } from './helpers.mjs';

const TEST_CONFIG = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures', 'test-config.json');

test('acceptance 2: tight USD budget caps the run cleanly', async () => {
  const ws = await tmpWorkspace('budget');
  const { code, events } = await runCli(['run', FIXTURE, '--profile', 'low-power', '--config', TEST_CONFIG, '--workspace', ws, '--budget-usd', '0.001']);
  assert.equal(code, 0, 'clean exit even when capped');
  const capped = events.filter((e) => e.type === 'budget.capped');
  assert.ok(capped.length >= 1, `budget.capped event emitted (got ${events.map((e) => e.type).join(',')})`);
  const flags = events.filter((e) => e.type === 'flag.found');
  assert.equal(flags.length, 0, 'no flag with 0.001 USD budget');
  const statuses = events.filter((e) => e.type === 'worker.status').map((e) => e.data.status);
  assert.ok(statuses.includes('capped'), 'workers report capped');
});

test('P1-11 & P1-12: usage.tick carries costUsd for worker and master, and master spend counts against swarm cap', async () => {
  const { loadConfig, resolveWorkspace } = await import('../src/config.mjs');
  const { createBus } = await import('../src/bus.mjs');
  const { createOrchestrator } = await import('../src/orchestrator.mjs');
  const { ingestChallenge } = await import('../src/ingest.mjs');
  const { replayFile } = await import('../src/store.mjs');
  const fs = await import('node:fs/promises');

  const ws = await tmpWorkspace('budget-master');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });

  const challengesDir = path.join(ws, 'challenges');
  await fs.mkdir(challengesDir, { recursive: true });
  const ing = await ingestChallenge({ source: 'path', value: FIXTURE, challengesDir, challengeId: 'ch.dot-ok' });

  const { swarmId } = await orch.startSwarm({
    challenge: { id: ing.challengeId, sourceType: 'path', sourceValue: FIXTURE, baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles },
    opts: { workers: 1, budgetUsd: 5.0 }
  });
  const s = orch.swarms.get(swarmId);
  await orch.directive(swarmId, 'Give me a status report.');
  await s.done;

  const events = await replayFile(path.join(ws, 'challenges', ing.challengeId, 'events', `${swarmId}.jsonl`));
  const workerTicks = events.filter((e) => e.type === 'usage.tick' && e.data.role === 'worker');
  const masterTicks = events.filter((e) => e.type === 'usage.tick' && e.data.role === 'master');
  assert.ok(workerTicks.length >= 1, 'worker usage.tick emitted');
  assert.ok(masterTicks.length >= 2, 'master usage.tick emitted for triage and directive');

  const price = config.providers.mock.pricePerMTok;
  for (const t of [...workerTicks, ...masterTicks]) {
    const expected = (t.data.tokensIn / 1e6) * price.in + (t.data.tokensOut / 1e6) * price.out;
    assert.ok(typeof t.data.costUsd === 'number' && Math.abs(t.data.costUsd - expected) < 1e-9, 'costUsd matches tokens * pricePerMTok');
  }

  // Master spend alone exceeding cap blocks preflight
  await assert.rejects(
    () => orch.startSwarm({
      challenge: { id: ing.challengeId, sourceType: 'path', sourceValue: FIXTURE, baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles },
      opts: { workers: 1, budgetUsd: 1e-7 }
    }),
    (e) => e.code === 'budget_capped'
  );
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
