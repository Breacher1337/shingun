import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { tmpWorkspace, runCli, FIXTURE } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');

/** Minimal USTAR reader with checksum verification — the extraction proof. */
function parseTar(buf) {
  const entries = [];
  let off = 0;
  for (;;) {
    const head = buf.subarray(off, off + 512);
    if (head.length < 512 || head.every((b) => b === 0)) break;
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/[^0-7]/g, ''), 8) || 0;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : head[i];
    const stored = parseInt(head.subarray(148, 156).toString('utf8').replace(/[^0-7]/g, ''), 8) || 0;
    assert.equal(stored, sum, `ustar checksum holds for ${name}`);
    entries.push({ name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(off <= buf.length, 'archive ends within its buffer');
  return entries;
}

async function runOneSolvedSwarm(ws) {
  const run = await runCli(['run', FIXTURE, '--config', TEST_CONFIG, '--workspace', ws, '--challenge-id', 'bundle-src'], { timeoutMs: 120000 });
  assert.equal(run.code, 0, `CLI run exited clean: ${run.stderr.slice(0, 400)}`);
  const sid = run.events[0]?.swarm;
  assert.ok(sid, 'run emitted at least one event');
  assert.ok(run.events.some((e) => e.type === 'swarm.update' && e.data?.final === true), 'swarm reached terminal');
  return { sid, run };
}

test('acceptance 3a: review bundle extracts with the full write-up set', async () => {
  const ws = await tmpWorkspace('bundle-');
  try {
    const { sid } = await runOneSolvedSwarm(ws);

    const out = await runCli(['bundle', sid, '--config', TEST_CONFIG, '--workspace', ws], { timeoutMs: 60000 });
    assert.equal(out.code, 0, `bundle exited clean: ${out.stderr.slice(0, 400)}`);
    const payload = out.events[0];
    assert.ok(payload?.path, 'bundle reported its output path');
    const bundlePath = payload.path;

    const raw = await fs.readFile(bundlePath);
    const tar = zlib.gunzipSync(raw);
    const entries = parseTar(tar);
    const names = entries.map((e) => e.name);

    // Every content class is present and non-trivial.
    assert.ok(names.includes('postmortem.md'), 'postmortem in bundle');
    const pm = entries.find((e) => e.name === 'postmortem.md');
    assert.ok(pm.data.length > 50, 'postmortem is real content');

    assert.ok(names.includes('flags.json'), 'flags.json in bundle');
    const flags = JSON.parse(entries.find((e) => e.name === 'flags.json').data.toString('utf8'));
    assert.equal(flags.swarm, sid);
    assert.ok(flags.flags[0].flag === 'shingun{m0ck_fl4g}', 'flag extracted from flag.found events');
    assert.equal(flags.flags[0].formatMatch, 'match');

    const transcripts = names.filter((n) => n.startsWith('transcripts/'));
    assert.ok(transcripts.length >= 1, 'solved worker transcript included');
    assert.ok(transcripts.every((n) => flags.flags.some((f) => n.includes(f.workerId))),
      'only flag-attributed worker transcripts are bundled');
    for (const t of transcripts) {
      assert.ok(entries.find((e) => e.name === t).data.length > 0, 'transcript is non-empty');
    }

    // Optional classes may be absent; when present they must parse.
    if (names.includes('notes.jsonl')) {
      const notes = entries.find((e) => e.name === 'notes.jsonl').data.toString('utf8').trim();
      for (const line of notes.split('\n')) JSON.parse(line);
    }

    // bundle.exported lands in the store — the event recap carries it.
    const evFile = path.join(ws, 'challenges', 'bundle-src', 'events', `${sid}.jsonl`);
    const store = (await fs.readFile(evFile, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const exported = store.find((e) => e.type === 'bundle.exported');
    assert.ok(exported, 'bundle.exported appended to the store');
    assert.equal(exported.data.path, bundlePath);
    assert.ok(exported.data.bytes > 0);
  } finally {
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance 3a-2: bundle refuses unknown and non-terminal swarms', async () => {
  const ws = await tmpWorkspace('bundle-err-');
  try {
    const unknown = await runCli(['bundle', 'sw-nope', '--config', TEST_CONFIG, '--workspace', ws], { timeoutMs: 30000 });
    assert.notEqual(unknown.code, 0, 'unknown swarm is a hard error');
    assert.match(unknown.stderr, /unknown swarm|error/i);

    // A store that never reached a terminal marker has nothing reviewable.
    const chDir = path.join(ws, 'challenges', 'ch-never-ends');
    const evDir = path.join(chDir, 'events');
    await fs.mkdir(evDir, { recursive: true });
    await fs.writeFile(path.join(evDir, 'sw-ghost.jsonl'),
      JSON.stringify({ v: 1, id: 'sw-ghost-00001', t: new Date().toISOString(), type: 'swarm.update', challenge: 'ch-never-ends', swarm: 'sw-ghost', worker: null, data: { status: 'running' } }) + '\n',
      'utf8');
    const early = await runCli(['bundle', 'sw-ghost', '--config', TEST_CONFIG, '--workspace', ws], { timeoutMs: 30000 });
    assert.notEqual(early.code, 0, 'non-terminal swarm refuses bundling');
    assert.match(early.stderr, /not terminal/i);
  } finally {
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance 3a-3: `shingun status` reads swarm state off disk', async () => {
  const ws = await tmpWorkspace('status-');
  try {
    const { sid } = await runOneSolvedSwarm(ws);
    const st = await runCli(['status', '--config', TEST_CONFIG, '--workspace', ws], { timeoutMs: 60000 });
    assert.equal(st.code, 0);
    const lines = st.events; // stdout is JSONL, so helpers' event parse doubles as line parse
    const mine = lines.find((l) => l.swarmId === sid);
    assert.ok(mine, 'status lists the finished swarm');
    assert.equal(mine.status, 'solved');
    assert.equal(mine.final, true);
    assert.deepEqual(mine.flags, ['shingun{m0ck_fl4g}']);
    assert.ok(mine.workers.length >= 1, 'workers summarized');
    assert.ok(mine.spentUsd > 0, 'usage cost digested');
  } finally {
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
