import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli, tmpWorkspace, FIXTURE } from './helpers.mjs';

const TEST_CONFIG = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'fixtures', 'test-config.json');

test('acceptance 1: mock swarm solves the fixture repo end to end', async () => {
  const ws = await tmpWorkspace('happy');
  const { code, events } = await runCli(['run', FIXTURE, '--profile', 'low-power', '--config', TEST_CONFIG, '--workspace', ws]);
  assert.equal(code, 0, 'clean exit');
  const types = (t) => events.filter((e) => e.type === t);
  assert.ok(types('challenge.ingested').length >= 1, 'challenge.ingested event');
  const triage = types('master.triage')[0];
  assert.ok(triage, 'master.triage event');
  assert.equal(triage.data.category, 'misc');
  assert.ok(triage.data.flagFormat?.regex, 'flag format from triage');
  const spawns = types('worker.spawn');
  assert.equal(spawns.length, 4, `4 workers spawned under low-power (got ${spawns.length})`);
  const flag = types('flag.found')[0];
  assert.ok(flag, 'flag.found event');
  assert.equal(flag.data.flag, 'shingun{m0ck_fl4g}');
  assert.equal(flag.data.formatMatch, 'match', 'advisory format match');
  const updates = types('swarm.update').map((e) => e.data.status);
  assert.ok(updates.includes('solved'), `swarm reached solved (got ${updates.join(',')})`);
  assert.ok(types('swarm.postmortem').length === 1, 'post-mortem written');
  const pmPath = types('swarm.postmortem')[0].data.path;
  const pm = await fs.readFile(pmPath, 'utf8');
  assert.match(pm, /Post-mortem: swarm/);
  assert.match(pm, /shingun\{m0ck_fl4g\}/);
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
