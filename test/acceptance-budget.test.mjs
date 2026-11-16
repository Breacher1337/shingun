import test from 'node:test';
import assert from 'node:assert';
import { runCli, tmpWorkspace, FIXTURE } from './helpers.mjs';

test('acceptance 2: tight USD budget caps the run cleanly', async () => {
  const ws = await tmpWorkspace('budget');
  const { code, events } = await runCli(['run', FIXTURE, '--profile', 'low-power', '--workspace', ws, '--budget-usd', '0.001']);
  assert.equal(code, 0, 'clean exit even when capped');
  const capped = events.filter((e) => e.type === 'budget.capped');
  assert.ok(capped.length >= 1, `budget.capped event emitted (got ${events.map((e) => e.type).join(',')})`);
  const flags = events.filter((e) => e.type === 'flag.found');
  assert.equal(flags.length, 0, 'no flag with 0.001 USD budget');
  const statuses = events.filter((e) => e.type === 'worker.status').map((e) => e.data.status);
  assert.ok(statuses.includes('capped'), 'workers report capped');
});
