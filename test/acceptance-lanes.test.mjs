import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli, tmpWorkspace, FIXTURE } from './helpers.mjs';
import { getProvider } from '../src/providers/registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LANES_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config-lanes.json');

test('model lane: registry resolves lanes:<name> through roles.lanes', () => {
  const config = {
    roles: {
      worker: { provider: 'mock', model: null },
      lanes: { coder: { provider: 'mock2', model: 'devstral' } }
    },
    providers: {
      mock: { type: 'mock', fixtureDir: './test/fixtures/mock' },
      mock2: { type: 'mock', fixtureDir: './test/fixtures/mock' }
    }
  };
  const laneProvider = getProvider(config, 'lanes:coder', { env: {} });
  assert.equal(laneProvider.name, 'mock2', 'lane resolves its own provider entry');
  const plainProvider = getProvider(config, 'worker', { env: {} });
  assert.equal(plainProvider.name, 'mock', 'worker role resolution is unchanged');
  assert.throws(
    () => getProvider(config, 'lanes:missing', { env: {} }),
    (e) => e.code === 'role_unconfigured' && /lanes:missing/.test(e.message),
    'unconfigured lane names itself in the error'
  );
});

test('model lane: rider personas ride the lane, everyone else rides the worker role', async () => {
  const ws = await tmpWorkspace('lanes-e2e');
  const { code, events } = await runCli(['run', FIXTURE, '--profile', 'low-power', '--config', LANES_CONFIG, '--workspace', ws]);
  assert.equal(code, 0, 'clean exit');

  const spawns = events.filter((e) => e.type === 'worker.spawn');
  // >=2: the solve may legally preempt trailing spawns (stopped-before-spawn),
  // and the preemption always lands on later persona indices.
  assert.ok(spawns.length >= 2, `lane-attributable workers spawned (got ${spawns.length})`);
  const scripterId = spawns.find((e) => e.data.persona === 'scripter')?.worker;
  const analystId = spawns.find((e) => e.data.persona === 'static-analyst')?.worker;
  assert.ok(scripterId, 'scripter persona spawned');
  assert.ok(analystId, 'static-analyst persona spawned');

  const ticks = events.filter((e) => e.type === 'usage.tick');
  const laneTicks = ticks.filter((e) => e.worker === scripterId);
  const plainTicks = ticks.filter((e) => e.worker === analystId);
  assert.ok(laneTicks.length >= 1, 'scripter usage ticked');
  assert.ok(plainTicks.length >= 1, 'static-analyst usage ticked');
  for (const t of laneTicks) {
    assert.equal(t.data.provider, 'mock2', 'scripter rides the lane provider');
    assert.equal(t.data.lane, 'coder', 'usage ticks carry the lane');
  }
  for (const t of plainTicks) {
    assert.equal(t.data.provider, 'mock', 'other personas stay on the worker role');
    assert.equal(t.data.lane, undefined, 'plain workers carry no lane field');
  }

  // The run stays a run: solved, flagged, post-mortem written as always.
  const flag = events.find((e) => e.type === 'flag.found');
  assert.ok(flag, 'flag.found unaffected by the lane');
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
