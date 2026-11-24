import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import timers from 'node:timers';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createGuardLedger } from '../src/ledger.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace } from './helpers.mjs';

/**
 * Cockpit v2: the master panel takes console-scope directives
 * — create challenges, launch swarms, purge, remove — through the guard
 * ledger. Everything here runs against the real engine over HTTP (or
 * direct orchestrator calls for fixtures the HTTP lane cannot select), in
 * mock-provider mode, on throwaway workspaces.
 *
 * Covered:
 *   4a  one typed console directive ingests the fixture folder and
 *       launches a 3-worker swarm (guard: instant); the thread persists to
 *       console/chat.jsonl and survives a serve restart (seed continuity).
 *   4b  majors parks creates as {pending, actionId} chips until confirm;
 *       a newer directive supersedes same-scope pending (410), unknown ids
 *       answer 404; purge stays gated even in instant mode and keeps every
 *       review artifact; remove refuses while a swarm is non-terminal.
 *   4c  route contracts: swarm optional on /api/master/message, guard
 *       validation, confirm receipts, unscoped /api/events replay.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');
const CHAT_FILE = path.join('console', 'chat.jsonl');
const OUTBOUND_FILE = path.join('console', 'master.outbound.jsonl');

const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

async function waitFor(fn, timeoutMs, everyMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const out = await Promise.resolve().then(() => fn()).catch(() => null);
    if (out) return out;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

const dirExists = (p) => fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
const fileExists = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false);

/** Parse a JSONL file; malformed tail lines are skipped. */
async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Raw JSON call; returns {status, data} without throwing on HTTP errors. */
async function call(base, route, { method = 'POST', body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function boot(ws) {
  ws ??= await tmpWorkspace('cockpit-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: { ...env }, bus });
  const srv = await startServer({
    config, env: { ...env }, orchestrator: orch, bus,
    workspaceDir: ws,
    webDir: path.join(ROOT, 'web'),
    envFile: path.join(ws, '.env'),
    configFile: path.join(ws, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  return { srv, orch, bus, ws, base };
}

async function drain(orch) {
  await Promise.all([...orch.swarms.values()].map((s) =>
    (typeof s.done?.then === 'function' ? s.done : Promise.resolve()).catch(() => {})));
  for (const s of orch.swarms.values()) {
    for (let i = 0; i < 200; i++) {
      const settled = [...s.workers.values()].every((w) => w.closed || w.isReservation);
      if (settled) break;
      await sleep(25);
    }
  }
}

async function teardown(ctx) {
  for (const [id] of ctx.orch.swarms) {
    await ctx.orch.stop(id, 'test-teardown').catch(() => {});
  }
  await drain(ctx.orch);
  await ctx.srv.close();
  fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 4a — console scope: one directive ingests the fixture and runs a swarm

test('cockpit 4a: an instant console directive registers the challenge and runs a 3-worker swarm to terminal', async () => {
  const ctx = await boot();
  try {
    const r = await call(ctx.base, '/api/master/message', {
      body: { text: 'attack the easy fixture with three workers', guard: 'instant' }
    });
    assert.equal(r.status, 200, 'message accepted');
    assert.equal(r.data.ok, true);

    // The exchange is stored as the console thread with sequential ids.
    const lines = await readJsonl(path.join(ctx.ws, CHAT_FILE));
    assert.equal(lines.length, 2, 'user + master console lines stored');
    assert.deepEqual(lines.map((l) => l.id), ['console-1', 'console-2'], 'ids are sequential');
    assert.equal(lines[0].data.direction, 'user');
    assert.equal(lines[0].data.scope, 'console');
    assert.equal(lines[1].data.direction, 'master');

    const acts = lines[1].data.actions;
    const createCh = acts.find((a) => a.op === 'create_challenge');
    const createSw = acts.find((a) => a.op === 'create_swarm');
    assert.ok(createCh, 'create_challenge proposed');
    assert.ok(createSw, 'create_swarm proposed');
    assert.ok(!createCh.pending && !createSw.pending, 'instant mode gates nothing');
    assert.ok(createCh.ok, 'create_challenge executed');
    assert.ok(createSw.ok, 'create_swarm executed');
    const { challengeId } = createCh.detail;
    const { swarmId } = createSw.detail;
    assert.match(String(swarmId), /^sw-/);
    assert.ok(await fileExists(path.join(ctx.ws, 'challenges', challengeId, 'challenge.json')),
      'challenge registered on disk');

    // The worker mock lane carries the new swarm to a terminal state.
    const solved = await waitFor(async () => {
      const st = await call(ctx.base, `/api/swarms/${swarmId}`, { method: 'GET' });
      return st.status === 200 && (st.data.status === 'solved' || st.data.final) ? st.data : null;
    }, 60000, 200);
    assert.ok(solved, 'swarm reached terminal state');
    assert.equal(solved.workers.length, 3, 'three workers ran');
    assert.ok(solved.flags.length >= 1, 'flag recorded');
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// 4a — the console thread survives a serve restart and seeds the master

test('cockpit 4a: the console thread survives a serve restart and seeds the next exchange', async () => {
  const ctx = await boot();
  const TEXT1 = 'first directive: inspect the node';
  let ctx2 = null;
  try {
    await call(ctx.base, '/api/master/message', { body: { text: TEXT1, guard: 'instant' } });
    const node = await ctx.orch.statusNode();
    const firstSwarm = node.liveSwarms[0]?.swarmId;
    assert.ok(firstSwarm, 'directive launched a swarm');

    // Let it finish (mock lane), then bounce the server completely.
    await waitFor(async () => {
      const st = await call(ctx.base, `/api/swarms/${firstSwarm}`, { method: 'GET' });
      return st.status === 200 && (st.data.status === 'solved' || st.data.final) ? st : null;
    }, 60000, 200);
    await drain(ctx.orch);
    await ctx.srv.close();

    // Fresh server + orchestrator on the same workspace: same thread file.
    ctx2 = await boot(ctx.ws);
    const r2 = await call(ctx2.base, '/api/master/message', { body: { text: 'second directive after the restart', guard: 'instant' } });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.ok, true);

    const lines = await readJsonl(path.join(ctx2.ws, CHAT_FILE));
    assert.deepEqual(lines.map((l) => l.id), ['console-1', 'console-2', 'console-3', 'console-4'],
      'thread ids continue across the restart');
    assert.equal(lines[2].data.direction, 'user', 'second exchange starts with the operator');

    // Continuity proof: the post-restart outbound prompt embeds the
    // pre-restart operator line as seed text.
    const outbound = await readJsonl(path.join(ctx2.ws, OUTBOUND_FILE));
    const seeded = outbound.filter((l) => l.kind === 'mock.outbound')
      .some((l) => JSON.stringify(l.messages ?? '').includes(TEXT1));
    assert.ok(seeded, 'continuity: the old exchange seeds the new master prompt');
  } finally {
    for (const [id] of ctx.orch.swarms) await ctx.orch.stop(id, 'test-teardown').catch(() => {});
    if (ctx2) {
      for (const [id] of ctx2.orch.swarms) await ctx2.orch.stop(id, 'test-teardown').catch(() => {});
      await drain(ctx2.orch);
      await ctx2.srv.close();
    }
    await drain(ctx.orch);
    await ctx.srv.close().catch(() => {});
    fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4b — majors guard: pending chips, confirm, supersede, unknown ids

test('cockpit 4b: majors parks creates as pending; confirm executes one; a newer directive supersedes the rest', async () => {
  const ctx = await boot();
  try {
    // No "guard" field: config defaults to majors.
    const r = await call(ctx.base, '/api/master/message', { body: { text: 'set up the easy fixture with three workers' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);

    let lines = await readJsonl(path.join(ctx.ws, CHAT_FILE));
    assert.equal(lines.length, 2, 'user + master lines');
    const chips = lines[1].data.actions;
    assert.equal(chips.length, 2);
    assert.ok(chips.every((a) => a.pending === true && typeof a.actionId === 'string'),
      'both creates are parked as pending chips');
    assert.equal(chips[0].op, 'create_challenge');
    assert.equal(chips[1].op, 'create_swarm');

    // Nothing may have executed yet.
    const challenges = await fs.readdir(path.join(ctx.ws, 'challenges')).catch(() => []);
    assert.equal(challenges.length, 0, 'no challenge on disk before confirm');
    assert.equal(ctx.orch.swarms.size, 0, 'no swarm before confirm');

    // Confirm the first chip: exactly one entry executes.
    const c1 = await call(ctx.base, '/api/master/confirm', { body: { actionId: chips[0].actionId } });
    assert.equal(c1.status, 200);
    assert.deepEqual(c1.data, { executed: true, actionId: chips[0].actionId });

    lines = await readJsonl(path.join(ctx.ws, CHAT_FILE));
    assert.equal(lines.length, 3, 'confirm receipt appended to the thread');
    const receipt = lines[2].data.actions[0];
    assert.equal(receipt.op, 'create_challenge');
    assert.equal(receipt.ok, true);
    const { challengeId } = receipt.detail;
    assert.ok(await fileExists(path.join(ctx.ws, 'challenges', challengeId, 'challenge.json')),
      'confirm registered the challenge');

    // A newer console directive supersedes the still-pending create_swarm.
    const r2 = await call(ctx.base, '/api/master/message', { body: { text: 'never mind launching — just report the node' } });
    assert.equal(r2.status, 200);

    const c2 = await call(ctx.base, '/api/master/confirm', { body: { actionId: chips[1].actionId } });
    assert.equal(c2.status, 410);
    assert.equal(c2.data.error.code, 'action_superseded');

    const c3 = await call(ctx.base, '/api/master/confirm', { body: { actionId: 'ac-no-such-action' } });
    assert.equal(c3.status, 404);
    assert.equal(c3.data.error.code, 'action_unknown');

    assert.equal(ctx.orch.swarms.size, 0, 'the superseded create_swarm never ran');
  } finally {
    await teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// 4b — the purge covenant: gated in every mode, review artifacts survive

test('cockpit 4b: purge stays confirm-gated in instant mode and keeps every review artifact', async () => {
  const ws = await tmpWorkspace('purge-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });
  try {
    // Stand up the target: an ungated console directive (engine-level, no
    // guard) that ingests the fixture folder and launches the swarm.
    await orch.directiveConsole({ text: 'attack the easy fixture with three workers' });
    const node = await orch.statusNode();
    const swarmId = node.liveSwarms[0]?.swarmId;
    assert.ok(swarmId, 'swarm is live');
    const s = orch.swarms.get(swarmId);
    const chDir = path.join(ws, 'challenges', s.challengeId);
    await waitFor(() => dirExists(path.join(chDir, 'worktrees')), 20000, 100);
    assert.ok(await dirExists(path.join(chDir, 'events')), 'event store exists before purge');

    // Propose the purge through the instant-mode ledger: still gated.
    const ledger = createGuardLedger({ config });
    const out = await orch.directiveConsole({
      text: 'purge that swarm',
      gate: (a) => ledger.gate({ ...a, mode: 'instant' }),
      meta: { fixture: 'console-purge', key: 'console-purge', role: 'master' }
    });
    const chip = out.actions.find((a) => a.op === 'purge_swarm');
    assert.ok(chip, 'purge proposed');
    assert.equal(chip.pending, true, 'purge is gated even in instant mode');
    assert.ok(typeof chip.actionId === 'string');

    // Confirm executes exactly one entry and reports the covenant.
    const { action, entry } = await ledger.confirm(chip.actionId);
    await orch.recordExecuted({ entry, action });
    assert.equal(action.op, 'purge_swarm');
    assert.equal(action.ok, true);
    assert.equal(action.detail.swarmId, swarmId);
    assert.deepEqual(action.detail.kept, ['events', 'transcripts', 'diffs', 'postmortems', 'bundles'],
      'the reply names what survived');

    // Working artifacts are gone; review artifacts remain.
    for (const d of ['worktrees', 'scratch', 'tools']) {
      assert.ok(!(await dirExists(path.join(chDir, d))), `${d} purged`);
    }
    const kept = await fs.readdir(path.join(chDir, 'events'));
    assert.ok(kept.some((f) => f === `${swarmId}.jsonl`), 'the purged swarm keeps its event store');

    // A second confirm of the same actionId is refused: entries run once.
    await assert.rejects(
      () => ledger.confirm(chip.actionId),
      (e) => e.code === 'action_unknown',
      'confirmed actions do not run twice'
    );
  } finally {
    for (const [id] of orch.swarms) await orch.stop(id, 'test-teardown').catch(() => {});
    await Promise.all([...orch.swarms.values()].map((x) =>
      (typeof x.done?.then === 'function' ? x.done : Promise.resolve()).catch(() => {})));
    for (const sw of orch.swarms.values()) {
      for (let i = 0; i < 200; i++) {
        const settled = [...sw.workers.values()].every((w) => w.closed || w.isReservation);
        if (settled) break;
        await sleep(25);
      }
    }
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4b — remove_challenge: refused while a swarm is non-terminal, then clean

test('cockpit 4b: remove_challenge refuses under a non-terminal swarm and removes once terminal', async () => {
  const ws = await tmpWorkspace('rmchallenge-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env, bus });
  try {
    // Register a challenge (ungated engine-level console directive).
    await orch.directiveConsole({ text: 'attack the easy fixture with three workers' });
    const node = await orch.statusNode();
    const challengeId = node.challenges.ids[0];
    assert.ok(challengeId, 'challenge registered');
    const chDir = path.join(ws, 'challenges', challengeId);

    // Forge a non-terminal store: a crash-recovery case — the swarm on
    // disk says "running", so the whole challenge directory is protected.
    const evDir = path.join(chDir, 'events');
    await fs.mkdir(evDir, { recursive: true });
    await fs.writeFile(path.join(evDir, 'sw-fake.jsonl'), JSON.stringify({
      v: 1, id: 'sw-fake-00001', t: new Date().toISOString(),
      type: 'swarm.update', swarm: 'sw-fake', challenge: challengeId,
      data: { status: 'running' }
    }) + '\n', 'utf8');

    const refuse = await orch.directiveConsole({
      text: 'remove that challenge',
      meta: { fixture: 'console-remove', key: 'console-remove', role: 'master' }
    });
    const refusal = refuse.actions.find((a) => a.op === 'remove_challenge');
    assert.equal(refusal.ok, false, 'refused while a swarm is non-terminal');
    assert.equal(refusal.detail.code, 'swarms_active');
    assert.ok(await dirExists(chDir), 'the refusenik keeps its directory');

    // The same swarm going terminal unlocks the removal.
    await fs.writeFile(path.join(evDir, 'sw-fake.jsonl'), JSON.stringify({
      v: 1, id: 'sw-fake-00001', t: new Date().toISOString(),
      type: 'swarm.update', swarm: 'sw-fake', challenge: challengeId,
      data: { status: 'stopped', final: true }
    }) + '\n', 'utf8');

    // Stop the live swarm first — the remove covenant also refuses when a
    // LIVE in-memory swarm is bound to the challenge.
    const liveIds = [...orch.swarms.keys()];
    for (const id of liveIds) await orch.stop(id, 'test-teardown').catch(() => {});
    await Promise.all([...orch.swarms.values()].map((x) =>
      (typeof x.done?.then === 'function' ? x.done : Promise.resolve()).catch(() => {})));
    for (const sw of orch.swarms.values()) {
      for (let i = 0; i < 200; i++) {
        const settled = [...sw.workers.values()].every((w) => w.closed || w.isReservation);
        if (settled) break;
        await sleep(25);
      }
    }

    const again = await orch.directiveConsole({
      text: 'now remove that challenge for real',
      meta: { fixture: 'console-remove', key: 'console-remove', role: 'master' }
    });
    const removal = again.actions.find((a) => a.op === 'remove_challenge');
    assert.equal(removal.ok, true, 'terminal challenge removed');
    assert.deepEqual(removal.detail, { challengeId, removed: true });
    assert.ok(!(await dirExists(chDir)), 'the challenge directory is gone');
  } finally {
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4b — guard matrix wire-up at the ledger level

test('cockpit 4b: the guard matrix reads never gated, purge always gated, majors covers creates and stops', async () => {
  const { config } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  assert.equal(config.cockpit?.guard ?? 'majors', 'majors', 'default guard is majors');
  const ledger = createGuardLedger({ config });
  const ran = [];
  const mk = (op) => ({ op, args: {}, scope: 'console', swarm: null, execute: async () => ({ detail: op }) });

  for (const op of ['status_report', 'status_node']) {
    const out = await ledger.gate({ ...mk(op), mode: 'majors' });
    assert.equal(out.pending, undefined, `${op} is a read — never gated`);
    assert.equal(out.ok, true);
  }
  for (const mode of ['instant', 'majors', 'all']) {
    const out = await ledger.gate({ ...mk('purge_swarm'), mode });
    assert.equal(out.pending, true, `purge_swarm gated in ${mode}`);
  }
  for (const op of ['create_challenge', 'create_swarm', 'remove_challenge', 'stop_swarm']) {
    const out = await ledger.gate({ ...mk(op), mode: 'majors', execute: async () => { ran.push(op); return { detail: op }; } });
    assert.equal(out.pending, true, `${op} gated in majors`);
    const outAll = await ledger.gate({ ...mk(op), mode: 'all' });
    assert.equal(outAll.pending, true, `${op} gated in all`);
  }
  for (const op of ['spawn_worker', 'prune_worker']) {
    const out = await ledger.gate({ ...mk(op), mode: 'majors' });
    assert.equal(out.pending, undefined, `${op} instant in majors`);
    const outAll = await ledger.gate({ ...mk(op), mode: 'all' });
    assert.equal(outAll.pending, true, `${op} gated in all`);
  }
  assert.equal(ran.length, 0, 'nothing pending-gated ever executed');

  // Mode validation drives the route's 400s.
  assert.equal(ledger.validateMode(undefined), 'majors', 'absent mode falls to the default');
  for (const m of ['instant', 'majors', 'all']) assert.equal(ledger.validateMode(m), m);
  assert.throws(() => ledger.validateMode('yolo'), (e) => e.code === 'bad_request');
});

// ---------------------------------------------------------------------------
// 4c — route contracts

test('cockpit 4c: routes validate body shape, guard mode, and replay the console backlog over unscoped SSE', async () => {
  const ctx = await boot();
  try {
    // Text is required in both scopes.
    assert.equal((await call(ctx.base, '/api/master/message', { body: { guard: 'instant' } })).status, 400,
      'empty text rejected');
    assert.equal((await call(ctx.base, '/api/master/message', { body: { text: 'hi', guard: 'sometimes' } })).status, 400,
      'unknown guard mode rejected');
    assert.equal((await call(ctx.base, '/api/master/message', { body: { text: 'hi', swarmId: 'sw-x' } })).status, 400,
      'swarmId is not the field name');
    assert.equal((await call(ctx.base, '/api/master/confirm', { body: {} })).status, 400,
      'confirm requires an actionId');
    assert.equal((await call(ctx.base, '/api/master/confirm', { body: { actionId: 'ac-missing' } })).status, 404,
      'confirm of an unknown id 404s');

    // console.chat lines exist; the unscoped stream replays them.
    await call(ctx.base, '/api/master/message', { body: { text: 'hello over the console', guard: 'instant' } });
    const lines = await readJsonl(path.join(ctx.ws, CHAT_FILE));
    assert.equal(lines.length, 2, 'one exchange stored');

    const ac = new AbortController();
    const res = await fetch(ctx.base + '/api/events', { signal: ac.signal });
    assert.equal(res.status, 200, 'unscoped /api/events subscribes');
    const reader = res.body.getReader();
    const seen = [];
    const deadline = Date.now() + 8000;
    while (seen.filter((l) => l.id?.startsWith('console-')).length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const block of new TextDecoder().decode(value).split('\n\n')) {
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) {
          try { seen.push(JSON.parse(data.slice(6))); } catch { /* heartbeat */ }
        }
      }
    }
    ac.abort();
    const consoleLines = seen.filter((l) => l.id?.startsWith('console-'));
    assert.equal(consoleLines.length, 2, 'the console backlog replayed over SSE');
    assert.deepEqual(consoleLines.map((l) => l.id), ['console-1', 'console-2']);
    assert.ok(seen.every((l) => l.swarm == null), 'the unscoped stream carries only console events');
  } finally {
    await teardown(ctx);
  }
});

// GET /api/node: node-scope read-back — guard mode, pending ledger with
// actionIds, console thread tail, compact swarm summaries. A read, never gated.
test('cockpit 4c: GET /api/node read-back shows guard, pending, console tail, swarms', async () => {
  const ctx = await boot();
  try {
    let r = await call(ctx.base, '/api/node', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.equal(r.data.guard, 'majors');
    assert.deepEqual(r.data.pending, []);
    assert.deepEqual(r.data.consoleThread, []);
    assert.deepEqual(r.data.swarms, []);

    await call(ctx.base, '/api/master/message', { body: { text: 'attack the easy fixture with three workers', guard: 'instant' } });
    await waitFor(async () => {
      const s = await call(ctx.base, '/api/node', { method: 'GET' });
      return s.data.swarms.length === 1 ? s.data : null;
    }, 15000);
    r = await call(ctx.base, '/api/node', { method: 'GET' });
    assert.equal(r.data.swarms.length, 1, 'one swarm summarized');
    const sw = r.data.swarms[0];
    assert.equal(typeof sw.id, 'string');
    assert.ok(sw.challenge.startsWith('ch-'), 'summary carries the challenge id');
    assert.equal(typeof sw.status, 'string');
    assert.equal(typeof sw.flagsCount, 'number');
    assert.ok(r.data.consoleThread.length >= 2, 'console tail carries the exchange');
    assert.ok(r.data.consoleThread.every((l) => String(l.id).startsWith('console-')));

    await call(ctx.base, '/api/master/message', { body: { text: 'attack the easy fixture with three workers', guard: 'majors' } });
    const withPending = await waitFor(async () => {
      const s = await call(ctx.base, '/api/node', { method: 'GET' });
      return s.data.pending.length >= 1 ? s.data : null;
    }, 8000);
    assert.ok(withPending, 'a majors-gated directive parks a pending chip');
    assert.ok(withPending.pending.every((p) => typeof p.actionId === 'string' && typeof p.op === 'string'));
    assert.equal(withPending.guard, 'majors');
  } finally {
    await teardown(ctx);
  }
});
