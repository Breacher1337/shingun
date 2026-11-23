import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeJail, denylistHit } from '../src/jail.mjs';
import { createLocalRunner } from '../src/runner.mjs';
import { executeTool } from '../src/workertools.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

test('acceptance 3a: path jail refuses escapes and admits in-root paths', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jail-'));
  const wt = path.join(base, 'worktree');
  const scratch = path.join(base, 'scratch');
  await fs.mkdir(wt, { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(base, 'outside.txt'), 'secret', 'utf8');
  const jail = await makeJail([wt, scratch]);

  const inside = await jail.check(path.join(wt, 'notes.txt')); // not existing yet
  assert.equal(inside.ok, true);
  const rel = await jail.check(path.resolve(wt, '../outside.txt'));
  assert.equal(rel.ok, false, 'parent escape refused');

  // symlink escape: link inside pointing outside.
  // On Windows without Developer Mode, creation is EPERM; POSIX covers this
  // on the Linux target.
  let linkCreated = false;
  try {
    await fs.symlink(path.join(base, 'outside.txt'), path.join(wt, 'leak.txt'));
    linkCreated = true;
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    t.skip('symlink creation is EPERM on this Windows setup; covered on the Linux target');
  }
  if (linkCreated) {
    const leak = await jail.check(path.join(wt, 'leak.txt'));
    assert.equal(leak.ok, false, 'symlink escape refused');
  }
  fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

test('acceptance 3b: deny-list refuses, everything else runs', async () => {
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const config = structuredClone(DEFAULT_CONFIG);
  const runner = createLocalRunner({ config });
  const r1 = await runner.run('cat /etc/shadow', { cwd: process.cwd() });
  assert.equal(r1.exitCode, 126, 'denylist refusal code');
  assert.match(r1.stdout, /DENYLIST/);
  const r2 = await runner.run('sudo rm x', { cwd: process.cwd() });
  assert.equal(r2.exitCode, 126);
  const r3 = await runner.run('node -e "console.log(1+1)"', { cwd: process.cwd() });
  assert.equal(r3.exitCode, 0);
  assert.equal(stripAnsi(r3.stdout).trim(), '2');
  assert.ok(denylistHit('sudo rm', config.denylist) === 'sudo');
});

test('acceptance 3c: tool layer refuses jailed writes and reports cleanly', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jailtools-'));
  const wt = path.join(base, 'wt');
  const scratch = path.join(base, 'scratch');
  await fs.mkdir(wt, { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const runner = createLocalRunner({ config });
  const jail = await makeJail([wt, scratch]);
  const ctx = { config, jail, runner, worktreePath: wt, hooks: { submitFlag: () => ({}), finish: () => ({}) } };

  const escape = await executeTool({ name: 'write_file', args: { path: '../escape.txt', content: 'x' }, ctx });
  assert.equal(escape.error, 'path_jail');

  const ok = await executeTool({ name: 'write_file', args: { path: 'solver.py', content: 'print(1)' }, ctx });
  assert.ok(ok.bytes > 0);
  const read = await executeTool({ name: 'read_file', args: { path: 'solver.py', offset: 0, limit: 5 }, ctx });
  assert.match(read.text ?? String(read.content) ?? JSON.stringify(read), /print\(1\)|bytes/);

  const denied = await executeTool({ name: 'run_shell', args: { command: 'cat /etc/shadow' }, ctx });
  assert.equal(denied.exitCode, 126);
  fs.rm(base, { recursive: true, force: true }).catch(() => {});
});
