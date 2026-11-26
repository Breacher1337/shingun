import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { ingestChallenge } from '../src/ingest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('engine: master directive answered via master.chat events', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-'));
  const { config, env } = await loadConfig({ file: path.join(ROOT, 'test', 'fixtures', 'test-config.json'), profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });

  const ing = await ingestChallenge({
    source: 'path',
    value: path.join(ROOT, 'test', 'fixtures', 'challenge-easy'),
    challengesDir: path.join(ws, 'challenges')
  });
  const { swarmId } = await orch.startSwarm({
    challenge: {
      id: ing.challengeId, sourceType: 'path', sourceValue: '(test)',
      baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles,
      flagFormatRegex: null, categoryHint: null
    },
    opts: {}
  });

  const out = await orch.directive(swarmId, 'Give me a status report.');
  assert.ok(out.reply, 'master replied');
  assert.ok(out.actions.some((a) => a.op === 'status_report'), 'status_report action executed');

  // The exchange must be persisted as master.chat events (user + master).
  await new Promise((r) => setTimeout(r, 300));
  const events = await orch.swarms.get(swarmId).store.replay();
  const chats = events.filter((e) => e.type === 'master.chat');
  assert.equal(chats.length, 2, 'user + master chat events stored');
  assert.equal(chats[0].data.direction, 'user');
  assert.equal(chats[1].data.direction, 'master');

  await orch.stop(swarmId, 'test-teardown').catch(() => {});
  // Deterministic teardown: wait until every worker promise chain has fully
  // settled before removing ws.
  const s = orch.swarms.get(swarmId);
  for (let i = 0; i < 200; i++) {
    const allClosed = [...s.workers.values()].every((w) => w.closed || w.isReservation);
    if (allClosed) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
