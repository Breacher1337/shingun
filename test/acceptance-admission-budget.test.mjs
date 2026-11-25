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

test('acceptance 4c: single per-swarm hard cap enforces preflight and explains cap in one line', async () => {
  const capped = [];
  const guard = createBudgetGuard({ usdCap: 0.001, onCapped: (msg) => capped.push(msg) });
  const pre = guard.preflight({ estTokens: 100, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(pre.ok, true, 'small call under cap is allowed');
  const rec = guard.record({ tokensIn: 1000, tokensOut: 1000, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(rec.crossed, true, 'reconcile detects crossing the hard cap');
  const pre2 = guard.preflight({ estTokens: 100, priceIn: 0.7, priceOut: 2.1 });
  assert.equal(pre2.ok, false);
  assert.equal(pre2.capName, 'usdCap');
  assert.match(pre2.message, /swarm hard cap reached/i);
  assert.equal(pre2.message.includes('\n'), false, 'refusal explains cap in one line');
  assert.equal(capped.length, 1);
});
