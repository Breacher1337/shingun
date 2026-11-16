import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMemAvailable, truncateBytes } from '../src/util.mjs';
import { admitWorker, sampleMemAvailable } from '../src/admission.mjs';
import { createBudgetGuard } from '../src/budget.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

test('acceptance 4a: meminfo parsing + truncate', async () => {
  assert.equal(parseMemAvailable('MemTotal: 100 kB\nMemAvailable: 512000 kB\n'), 500);
  assert.equal(parseMemAvailable('junk'), null);
  const t = truncateBytes('hello world', 5);
  assert.equal(t.text.startsWith('hello'), true);
  assert.equal(t.truncated, true);
});

test('acceptance 4b: admission gate blocks under watermark, admits above', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-'));
  const memfile = path.join(dir, 'meminfo');
  const config = structuredClone(DEFAULT_CONFIG);
  config.concurrency.machineWorkers = 4;
  config.admission = { ...config.admission, meminfoPath: memfile, watermarkMb: 1536 };

  await fs.writeFile(memfile, 'MemAvailable: 512000 kB\n', 'utf8'); // 500 MB
  const blocked = await admitWorker({ config, activeWorkers: 0, sample: () => sampleMemAvailable(memfile) });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'watermark');
  assert.equal(blocked.memAvailableMb, 500);

  await fs.writeFile(memfile, 'MemAvailable: 4096000 kB\n', 'utf8'); // 4000 MB
  const admitted = await admitWorker({ config, activeWorkers: 0, sample: () => sampleMemAvailable(memfile) });
  assert.equal(admitted.ok, true);

  const cap = await admitWorker({ config, activeWorkers: 4, sample: () => sampleMemAvailable(memfile) });
  assert.equal(cap.ok, false);
  assert.equal(cap.reason, 'cap');

  // off-Linux / missing file → gate skipped (dev machines)
  const skip = await admitWorker({ config, activeWorkers: 0, sample: async () => null });
  assert.equal(skip.ok, true);
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('acceptance 4c: budget guard estimate-then-reconcile trips caps', async () => {
  const events = [];
  const guard = createBudgetGuard({ onCapped: (scope, capName) => events.push({ scope, capName }) });
  guard.addScope('worker:w1', { tokenCap: 100, usdCap: Infinity });
  const pre = guard.preflight({ scopeIds: ['worker:w1'], estTokens: 100, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(pre.ok, true, 'exactly at cap is allowed');
  const rec = guard.record({ scopeIds: ['worker:w1'], tokensIn: 120, tokensOut: 30, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(rec.crossed.length, 1, 'reconcile detects the crossing');
  const pre2 = guard.preflight({ scopeIds: ['worker:w1'], estTokens: 10, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(pre2.ok, false);
  assert.equal(pre2.capName, 'maxTokens');
});
