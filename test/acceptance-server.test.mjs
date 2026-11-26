import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace, NODE, BIN } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHALLENGE = path.join(ROOT, 'test', 'fixtures', 'challenge-easy');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');
const TOKEN = 't-' + 'a'.repeat(40);

async function boot() {
  const ws = await tmpWorkspace('serve-');
  const loaded = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const config = structuredClone(loaded.config);
  config.roles = { master: { provider: 'mock', model: null }, worker: { provider: 'mock', model: null }, oracle: null };
  const env = { ...loaded.env };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: { ...env, SHINGUN_TOKEN: TOKEN }, bus });
  const srv = await startServer({
    config, env: { ...env, SHINGUN_TOKEN: TOKEN }, orchestrator: orch, bus,
    workspaceDir: ws, envFile: path.join(ws, '.env'),
    webDir: path.join(ROOT, 'web'),
    configFile: path.join(ws, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = async (p, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, headers: res.headers, body: data, text };
  };
  return { srv, orch, bus, ws, base, call };
}

async function waitFor(fn, timeoutMs, everyMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const out = await fn().catch(() => null);
    if (out) return out;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Minimal SSE reader until a predicate is satisfied or the stream drains. */
async function sseCollect(res, until, timeoutMs) {
  const events = [];
  const reader = res.body.getReader();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!block.includes('data: ')) continue;
        const json = JSON.parse(block.slice(block.indexOf('data: ') + 6));
        events.push(json);
        if (until(events)) return { events, done: true };
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { events, done: false };
}

async function teardown(ctx, swarmId) {
  if (swarmId) await ctx.orch.stop(swarmId, 'test-teardown').catch(() => {});
  // Let every swarm's completion path finish (post-mortem, final events)
  // before dropping the workspace: deleting earlier races lingering emits.
  await Promise.all([...ctx.orch.swarms.values()].map((s) =>
    (typeof s.done?.then === 'function' ? s.done : Promise.resolve()).catch(() => {})));
  for (const s of ctx.orch.swarms.values()) {
    for (let i = 0; i < 200; i++) {
      const settled = [...s.workers.values()].every((w) => w.closed || w.isReservation);
      if (settled) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  await ctx.srv.close();
  fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
}

test('acceptance 2a: server boots and gates everything behind the token', async (t) => {
  const ctx = await boot();
  try {
    // Bearer gate: no token, wrong token, on data and SSE routes alike.
    const noAuth = await ctx.call('/api/swarms/sw-nope', { auth: false });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error.code, 'unauthorized');

    const noAuthSse = await fetch(`${ctx.base}/api/events`);
    assert.equal(noAuthSse.status, 401);
    await noAuthSse.body.cancel().catch(() => {});

    const wrongToken = await fetch(ctx.base + '/', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrongToken.status, 401);
    await wrongToken.body.cancel().catch(() => {});

    const badStatic = await ctx.call('/nope.js');
    assert.equal(badStatic.status, 404);
    const oldStyle = await ctx.call('/style.css');
    assert.equal(oldStyle.status, 404, 'dashboard assets removed');

    // Gated root status route also refuses unauthenticated requests as JSON.
    const unauthRoot = await fetch(ctx.base + '/');
    assert.equal(unauthRoot.status, 401);
    assert.match(unauthRoot.headers.get('content-type') ?? '', /application\/json/);
    await unauthRoot.body.cancel().catch(() => {});

    // Authorized minimal JSON status route on GET /.
    const root = await ctx.call('/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.equal(root.body.ok, true);
    assert.equal(root.body.service, 'shingun');

    // Server binds localhost only.
    assert.equal(ctx.srv.server.address().address, '127.0.0.1');
  } finally {
    await ctx.call('/api/v1/roles', { method: 'PUT', body: { both: 'mock' } }).catch(() => {});
    await teardown(ctx);
  }
});

test('acceptance 2a-2: without SHINGUN_TOKEN the workspace is open — and host-guarded', async () => {
  const ws = await tmpWorkspace('open-');
  const { config, env } = await loadConfig({ file: path.join(ROOT, 'test', 'fixtures', 'test-config.json'), profile: 'low-power' });
  const openedEnv = { ...env };
  delete openedEnv.SHINGUN_TOKEN;
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: openedEnv, bus });
  const srv = await startServer({
    config, env: openedEnv, orchestrator: orch, bus, workspaceDir: ws,
    envFile: path.join(ws, '.env'), webDir: path.join(ROOT, 'web')
  });
  try {
    await srv.listen(0);
    assert.equal(srv.gated, false, 'no token in env means open mode');
    const base = `http://127.0.0.1:${srv.server.address().port}`;

    // Minimal JSON status route answers open.
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    assert.equal((await root.json()).service, 'shingun');

    // Data routes answer without any Authorization header.
    const providers = await fetch(base + '/api/providers');
    assert.equal(providers.status, 200);
    const info = await providers.json();
    assert.ok(info.providers && info.roles, 'provider scan open');

    // The rebinding substitute: foreign Host names are refused outright.
    const forbidden = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.server.address().port, path: '/api/providers',
        headers: { Host: 'evil.example' }
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(forbidden, 403, 'a rebinding hostname never reaches a route');
  } finally {
    await srv.close();
    for (const s of orch.swarms.values()) {
      for (let i = 0; i < 200; i++) {
        if ([...s.workers.values()].every((w) => w.closed || w.isReservation)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance 2b: challenge → swarm visible end-to-end over HTTP + SSE', async (t) => {
  const ctx = await boot();
  let swarmId = null;
  try {
    // Register the challenge over HTTP with /api/v1/challenges (201 + Location).
    const bad = await ctx.call('/api/v1/challenges', { method: 'POST', body: { source: 'x', value: '' } });
    assert.equal(bad.status, 400);
    const ch = await ctx.call('/api/v1/challenges', {
      method: 'POST',
      body: { source: 'path', value: CHALLENGE, flagFormatRegex: 'shingun\\{[^}]*\\}' }
    });
    assert.equal(ch.status, 201, 'creation returns 201 Created');
    assert.equal(ch.headers.get('location'), `/api/v1/challenges/${ch.body.challengeId}`, 'Location header set');
    const challengeId = ch.body.challengeId;
    assert.ok(challengeId);

    // Read back challenge metadata via GET /api/v1/challenges/:id
    const meta = await ctx.call(`/api/v1/challenges/${challengeId}`);
    assert.equal(meta.status, 200);
    assert.equal(meta.body.challengeId, challengeId);

    // Launch swarm with /api/v1/challenges/:id/swarms (201 + Location).
    const bad2 = await ctx.call(`/api/v1/challenges/${challengeId}/swarms`, { method: 'POST', body: { workers: 99 } });
    assert.equal(bad2.status, 201, 'swarm creation returns 201 Created'); // clamps to concurrency caps, not an error
    assert.equal(bad2.headers.get('location'), `/api/v1/swarms/${bad2.body.swarmId}`, 'Location header set');
    assert.ok(bad2.body.swarmId);
    swarmId = bad2.body.swarmId;

    // Unknown swarm reads are 404.
    const unknown = await ctx.call('/api/v1/swarms/sw-void');
    assert.equal(unknown.status, 404);

    // SSE backlog replays from event 0 for auth'd subscribers.
    const sse = await fetch(`${ctx.base}/api/v1/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);

    // A second, later subscriber also gets the full backlog replay.
    const back2 = await fetch(`${ctx.base}/api/v1/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const early = await sseCollect(back2, (evs) => evs.some((e) => e.type === 'worker.spawn'), 5000);
    assert.ok(early.events.find((e) => e.type === 'challenge.ingested'), 'backlog starts from event 0');
    assert.ok(early.events.find((e) => e.type === 'master.triage'));
    await back2.body.cancel().catch(() => {});

    // Swarm state reconstructs via replay: poll to solved.
    const solved = await waitFor(async () => {
      const snap = await ctx.call(`/api/v1/swarms/${swarmId}`);
      assert.equal(snap.status, 200);
      return ['solved', 'stopped', 'capped'].includes(snap.body.status) ? snap.body : null;
    }, 60000);
    assert.ok(solved, `swarm reached a terminal state (got: ${JSON.stringify(solved)}`);
    assert.equal(solved.status, 'solved');
    assert.equal(solved.flags[0].flag, 'shingun{m0ck_fl4g}');
    assert.ok(solved.workers.length >= 1, 'workers are visible');
    assert.ok(solved.workers.every((w) => typeof w.persona === 'string'));
    assert.equal('budget' in solved, false, 'budget surface removed from swarm API');
    assert.equal('caps' in solved, false, 'caps surface removed from swarm API');
    assert.ok(solved.lastSeq >= 1, 'replay position is exported');

    // The live stream also carries the flag and the final status.
    const stream = await sseCollect(sse, (evs) =>
      evs.some((e) => e.type === 'flag.found') && evs.some((e) => e.type === 'swarm.update' && e.data.status === 'solved'), 30000);
    assert.ok(stream.events.find((e) => e.type === 'flag.found' && e.data.flag === 'shingun{m0ck_fl4g}'), 'flag.found streamed');
    assert.ok(stream.events.find((e) => e.type === 'usage.tick'), 'usage ticks streamed');
    await sse.body.cancel().catch(() => {});

    // Flag trophy attribution.
    const snap2 = await ctx.call(`/api/v1/swarms/${swarmId}`);
    const solvedWorker = snap2.body.workers.find((w) => (w.flags ?? []).includes('shingun{m0ck_fl4g}'));
    assert.ok(solvedWorker, 'a worker is attributed the flag');
  } finally {
    await teardown(ctx, swarmId);
  }
});

test('acceptance 2c: command deck round-trip lands as master.chat over SSE', async (t) => {
  const ctx = await boot();
  let swarmId = null;
  try {
    const ch = await ctx.call('/api/v1/challenges', { method: 'POST', body: { source: 'path', value: CHALLENGE } });
    assert.equal(ch.status, 201);
    const sw = await ctx.call(`/api/v1/challenges/${ch.body.challengeId}/swarms`, { method: 'POST', body: { workers: 2 } });
    assert.equal(sw.status, 201);
    swarmId = sw.body.swarmId;

    // The directive must run while the swarm is live (the swarm is still in
    // its spawn wave: worktree checkouts take far longer than this round-trip).
    const sse = await fetch(`${ctx.base}/api/v1/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const res = await ctx.call('/api/v1/master/messages', {
      method: 'POST', body: { swarm: swarmId, text: 'Give me a status report.' }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true }, 'replies never travel in the HTTP body');

    // The exchange lands as master.chat events: user + master with actions.
    const chats = await sseCollect(sse, (evs) => evs.filter((e) => e.type === 'master.chat').length >= 2, 20000);
    const chatEvents = chats.events.filter((e) => e.type === 'master.chat');
    assert.ok(chatEvents.length >= 2, 'user + master chat streamed');
    assert.equal(chatEvents[0].data.direction, 'user');
    assert.equal(chatEvents[0].data.text, 'Give me a status report.');
    const masterReply = chatEvents.find((e) => e.data.direction === 'master');
    assert.ok(masterReply, 'master reply streamed');
    assert.ok(Array.isArray(masterReply.data.actions), 'actions ride the reply');
    const withStatus = await waitFor(async () => {
      const snap = await ctx.call(`/api/v1/swarms/${swarmId}`);
      const chat = snap.body.masterChat ?? [];
      return chat.length >= 2 ? chat : null;
    }, 20000);
    assert.ok(withStatus.every((m) => typeof m.text === 'string'));
    const replied = withStatus[1];
    assert.equal(replied.direction, 'master');
    await sse.body.cancel().catch(() => {});

    // Steering a live worker queues a note, unknown ids are 404.
    const snapA = await ctx.call(`/api/v1/swarms/${swarmId}`);
    const wid = snapA.body.workers[0]?.id;
    if (wid) {
      const steer = await ctx.call(`/api/v1/swarms/${swarmId}/workers/${wid}/messages`, {
        method: 'POST', body: { text: 'prioritize the README' }
      });
      assert.equal(steer.status, 200);
      assert.equal(steer.body.queued, true);
    }
    const steerBad = await ctx.call(`/api/v1/swarms/${swarmId}/workers/w-void/messages`, {
      method: 'POST', body: { text: 'x' }
    });
    assert.equal(steerBad.status, 404);

    // Diff endpoint: 200 with shape after settle, 404 for a worker that never ran.
    await ctx.orch.swarms.get(swarmId).done.catch(() => {});
    const diffWid = (await ctx.call(`/api/v1/swarms/${swarmId}`)).body.workers[0].id;
    const diff = await waitFor(async () => {
      const d = await ctx.call(`/api/v1/swarms/${swarmId}/workers/${diffWid}/diff`);
      return d.status === 200 ? d : null;
    }, 15000);
    assert.ok(diff, 'diff is captured once the worker settles');
    assert.ok(diff.body.stats === null || typeof diff.body.stats.files === 'number', 'diff stats shape');
    const diffNone = await ctx.call(`/api/v1/swarms/${swarmId}/workers/w-none/diff`);
    assert.equal(diffNone.status, 404);

    // Stop route: DELETE /api/v1/swarms/:id reports already-stopped; unknown is 404.
    const stop = await ctx.call(`/api/v1/swarms/${swarmId}`, { method: 'DELETE' });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopped, true);
    const stopUnknown = await ctx.call('/api/v1/swarms/sw-void', { method: 'DELETE' });
    assert.equal(stopUnknown.status, 404);
  } finally {
    await teardown(ctx, swarmId);
  }
});

test('acceptance 2e: provider key scan + provisioning via PUT /api/v1/providers/:provider/key and PUT /api/v1/roles', async () => {
  const ctx = await boot();
  try {
    // Scan: metadata + booleans only — never key values.
    const scan = await ctx.call('/api/v1/providers');
    assert.equal(scan.status, 200);
    assert.ok(scan.body.providers.mistral, 'mistral listed');
    assert.equal(scan.body.providers.mistral.type, 'openai-compat');
    assert.equal(scan.body.providers.mistral.apiKeyEnv, 'MISTRAL_API_KEY');
    assert.equal(scan.body.providers.mock.hasKey, null, 'mock is keyless by design');
    assert.ok(typeof scan.body.providers.mistral.hasKey === 'boolean', 'hasKey is a boolean');

    // Validation: weak keys and unknown providers are refused via PUT /api/v1/providers/:provider/key.
    const bad = await ctx.call('/api/v1/providers/mistral/key', { method: 'PUT', body: { apiKey: 'short' } });
    assert.equal(bad.status, 400, 'weak key refused');
    const unknown = await ctx.call('/api/v1/providers/void/key', { method: 'PUT', body: { apiKey: 'x'.repeat(12) } });
    assert.equal(unknown.status, 400, 'unknown provider refused');
    const noKeyProvider = await ctx.call('/api/v1/providers/mock/key', { method: 'PUT', body: { apiKey: 'x'.repeat(12) } });
    assert.equal(noKeyProvider.status, 400, 'keyless provider refused');

    // Provision: live env, durable .env, role activation, persisted config via PUT.
    const KEY = 'sk-provision-0123456789abcdef';
    const ok = await ctx.call('/api/v1/providers/mistral/key', { method: 'PUT', body: { apiKey: KEY, activate: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.hasKey, true);
    assert.equal(ok.body.activated, true);
    assert.equal(ok.body.persisted, true);
    assert.ok(!JSON.stringify(ok.body).includes(KEY), 'response never echoes the key');

    // Role switching via PUT /api/v1/roles
    const roleOk = await ctx.call('/api/v1/roles', { method: 'PUT', body: { both: 'mistral' } });
    assert.equal(roleOk.status, 200);
    assert.equal(roleOk.body.roles.master.provider, 'mistral');
    assert.equal(roleOk.body.roles.worker.provider, 'mistral');

    const after = await ctx.call('/api/v1/providers');
    assert.equal(after.body.providers.mistral.hasKey, true, 'key visible as boolean');
    assert.equal(after.body.roles.master.provider, 'mistral', 'master role activated');
    assert.equal(after.body.roles.worker.provider, 'mistral', 'worker role activated');
    assert.ok(!JSON.stringify(after.body).includes(KEY), 'scan never leaks the key');

    const envText = await fs.readFile(path.join(ctx.ws, '.env'), 'utf8');
    assert.match(envText, new RegExp(`^MISTRAL_API_KEY=${KEY}$`, 'm'), 'key persisted to .env');
    const cfgText = await fs.readFile(path.join(ctx.ws, 'config.json'), 'utf8');
    assert.match(cfgText, /"provider"\s*:\s*"mistral"/, 'roles persisted to config file');
  } finally {
    await ctx.call('/api/v1/roles', { method: 'PUT', body: { both: 'mock' } }).catch(() => {});
    await teardown(ctx);
  }
});

test('acceptance 2f: Idempotency-Key support on creation endpoints caches and replays 201', async () => {
  const ctx = await boot();
  let swarmId = null;
  try {
    const KEY_CH = 'idem-challenge-' + Date.now();
    const ch1 = await ctx.call('/api/v1/challenges', {
      method: 'POST',
      body: { source: 'path', value: CHALLENGE },
      headers: { 'Idempotency-Key': KEY_CH }
    });
    assert.equal(ch1.status, 201);
    assert.ok(ch1.body.challengeId);
    assert.equal(ch1.headers.get('location'), `/api/v1/challenges/${ch1.body.challengeId}`);

    // Replay with identical key: returns cached 201 without error or duplicate ingest
    const ch2 = await ctx.call('/api/v1/challenges', {
      method: 'POST',
      body: { source: 'path', value: CHALLENGE },
      headers: { 'Idempotency-Key': KEY_CH }
    });
    assert.equal(ch2.status, 201);
    assert.equal(ch2.body.challengeId, ch1.body.challengeId);
    assert.equal(ch2.headers.get('location'), ch1.headers.get('location'));

    const KEY_SW = 'idem-swarm-' + Date.now();
    const sw1 = await ctx.call(`/api/v1/challenges/${ch1.body.challengeId}/swarms`, {
      method: 'POST',
      body: { workers: 2 },
      headers: { 'Idempotency-Key': KEY_SW }
    });
    assert.equal(sw1.status, 201);
    assert.ok(sw1.body.swarmId);
    swarmId = sw1.body.swarmId;

    // Replay with identical key: returns cached 201 with same swarmId
    const sw2 = await ctx.call(`/api/v1/challenges/${ch1.body.challengeId}/swarms`, {
      method: 'POST',
      body: { workers: 2 },
      headers: { 'Idempotency-Key': KEY_SW }
    });
    assert.equal(sw2.status, 201);
    assert.equal(sw2.body.swarmId, sw1.body.swarmId);
  } finally {
    await teardown(ctx, swarmId);
  }
});

test('acceptance 2g: idempotent repeated confirm returns executed receipt without error', async () => {
  const ctx = await boot();
  try {
    // Propose an action via majors mode directive
    const r = await ctx.call('/api/v1/master/messages', {
      method: 'POST',
      body: { text: 'set up the easy fixture with three workers', guard: 'majors' }
    });
    assert.equal(r.status, 200);

    const node = await ctx.call('/api/v1/node');
    assert.equal(node.status, 200);
    const chips = node.body.pending;
    assert.ok(chips.length >= 1, 'action was gated as pending');
    const actionId = chips[0].actionId;

    // First confirm: executes the action and returns receipt
    const c1 = await ctx.call('/api/v1/master/confirm', {
      method: 'POST',
      body: { actionId }
    });
    assert.equal(c1.status, 200);
    assert.equal(c1.body.executed, true);
    assert.equal(c1.body.actionId, actionId);

    // Second confirm: returns cached executed receipt (NOT 404 action_unknown!)
    const c2 = await ctx.call('/api/v1/master/confirm', {
      method: 'POST',
      body: { actionId }
    });
    assert.equal(c2.status, 200, 'idempotent repeat returns 200');
    assert.equal(c2.body.executed, true);
    assert.equal(c2.body.actionId, actionId);
  } finally {
    await ctx.call('/api/v1/roles', { method: 'PUT', body: { both: 'mock' } }).catch(() => {});
    await teardown(ctx);
  }
});

test('acceptance 2h: legacy /api/* routes backward compatibility as aliases/forwarders', async () => {
  const ctx = await boot();
  let swarmId = null;
  try {
    // Legacy GET /api/providers
    const prov = await ctx.call('/api/providers');
    assert.equal(prov.status, 200);
    assert.ok(prov.body.providers);

    // Legacy POST /api/challenges
    const ch = await ctx.call('/api/challenges', {
      method: 'POST',
      body: { source: 'path', value: CHALLENGE }
    });
    assert.equal(ch.status, 201);
    assert.ok(ch.body.challengeId);

    // Legacy POST /api/challenges/:id/swarm
    const sw = await ctx.call(`/api/challenges/${ch.body.challengeId}/swarm`, {
      method: 'POST',
      body: { workers: 2 }
    });
    assert.equal(sw.status, 201);
    assert.ok(sw.body.swarmId);
    swarmId = sw.body.swarmId;

    // Legacy GET /api/swarms/:id
    const snap = await ctx.call(`/api/swarms/${swarmId}`);
    assert.equal(snap.status, 200);

    // Legacy POST /api/master/message
    const msg = await ctx.call('/api/master/message', {
      method: 'POST',
      body: { swarm: swarmId, text: 'legacy status report' }
    });
    assert.equal(msg.status, 200);

    // Legacy POST /api/swarms/:id/stop
    const stop = await ctx.call(`/api/swarms/${swarmId}/stop`, {
      method: 'POST',
      body: {}
    });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopped, true);

    // Legacy GET /api/node
    const node = await ctx.call('/api/node');
    assert.equal(node.status, 200);
    assert.ok(Array.isArray(node.body.swarms));
  } finally {
    await teardown(ctx, swarmId);
  }
});

test('acceptance 2d: `shingun serve` boots the real CLI surface', async () => {
  const ws = await tmpWorkspace('clsrv-');
  const child = spawn(NODE, [BIN, 'serve', '--port', '0', '--config', TEST_CONFIG, '--workspace', ws], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    const statusUrl = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const m = /status: (\S+)/.exec(out);
        if (m) { clearInterval(timer); resolve(m[1]); }
        else if (Date.now() - t0 > 25000) {
          clearInterval(timer);
          reject(new Error(`serve did not print its status url: ${out.slice(0, 500)}`));
        }
      }, 100);
    });
    assert.match(statusUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const authMode = /auth: (token-gated|open workspace)/.exec(out)?.[1];
    if (authMode === 'token-gated') {
      const gate = await fetch(statusUrl);
      assert.equal(gate.status, 401, 'gated serve refuses bare status');
      await gate.body.cancel().catch(() => {});
    } else {
      const bare = await fetch(statusUrl);
      assert.equal(bare.status, 200, 'open serve answers minimal JSON status');
      const statusJson = await bare.json();
      assert.equal(statusJson.service, 'shingun');
      const providers = await fetch(new URL('/api/providers', statusUrl));
      assert.equal(providers.status, 200, 'open serve answers data routes without auth');
    }
  } finally {
    child.kill('SIGKILL');
    child.stdout.destroy?.();
    child.stderr.destroy?.();
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('P0-1: HTTP API rejects path-traversal ids with 400 bad_request and admits valid ids', async () => {
  const ctx = await boot();
  try {
    for (const badId of ['..%2F..%2F', '..%2Fetc', 'a%20b', 'bad$id']) {
      const g = await ctx.call(`/api/v1/challenges/${badId}`);
      assert.equal(g.status, 400, `GET challenges/${badId} must 400`);
      assert.equal(g.body.error.code, 'bad_request');

      const p = await ctx.call(`/api/v1/challenges/${badId}/swarms`, { method: 'POST', body: {} });
      assert.equal(p.status, 400, `POST challenges/${badId}/swarms must 400`);
      assert.equal(p.body.error.code, 'bad_request');

      const sw = await ctx.call(`/api/v1/swarms/${badId}`);
      assert.equal(sw.status, 400, `GET swarms/${badId} must 400`);
      assert.equal(sw.body.error.code, 'bad_request');
    }

    const ch = await ctx.call('/api/v1/challenges', { method: 'POST', body: { source: 'path', value: CHALLENGE } });
    assert.equal(ch.status, 201);
    const okMeta = await ctx.call(`/api/v1/challenges/${ch.body.challengeId}`);
    assert.equal(okMeta.status, 200);
    assert.equal(okMeta.body.challengeId, ch.body.challengeId);
  } finally {
    await teardown(ctx, null);
  }
});

test('P1-4: Origin validation rejects foreign Origin with 403 origin_forbidden and allows loopback/absent', async () => {
  const ctx = await boot();
  try {
    for (const badOrigin of ['https://evil.com', 'http://evil.com:8787', 'null', 'http://127.0.0.1.evil.com']) {
      const r1 = await fetch(`${ctx.base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: badOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      });
      assert.equal(r1.status, 403, `POST /mcp with Origin ${badOrigin} must 403`);
      assert.equal((await r1.json()).error.code, 'origin_forbidden');

      const r2 = await fetch(`${ctx.base}/api/v1/challenges`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: badOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(r2.status, 403, `POST /api/v1/challenges with Origin ${badOrigin} must 403`);
      assert.equal((await r2.json()).error.code, 'origin_forbidden');
    }

    for (const goodOrigin of ['http://127.0.0.1:8787', 'http://localhost:3000', 'http://[::1]:8787', 'http://localhost']) {
      const ok = await fetch(`${ctx.base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: goodOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      });
      assert.equal(ok.status, 200, `POST /mcp with Origin ${goodOrigin} must 200`);
    }
  } finally {
    await teardown(ctx, null);
  }
});

test('P2-1 & P2-3: oversized Content-Length and streamed body return 413 JSON, and GET /api/v1/node caches summaries', async () => {
  const ctx = await boot();
  const net = await import('node:net');
  try {
    // Content-Length > 256 KiB -> 413 JSON reaches client
    const bigJson = JSON.stringify({ pad: 'a'.repeat(300 * 1024) });
    const clRes = await fetch(`${ctx.base}/api/v1/challenges`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: bigJson
    });
    assert.equal(clRes.status, 413);
    assert.equal((await clRes.json()).error.code, 'payload_too_large');

    // Streamed chunked body without Content-Length > 256 KiB -> 413 JSON reaches client
    const port = ctx.srv.server.address().port;
    const streamedStatus = await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(
          `POST /api/v1/challenges HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${TOKEN}\r\n` +
          `Content-Type: application/json\r\n` +
          `Transfer-Encoding: chunked\r\n\r\n`
        );
        const chunk = Buffer.from('{"pad":"' + 'b'.repeat(300 * 1024) + '"}');
        sock.write(`${chunk.length.toString(16)}\r\n`);
        sock.write(chunk);
        sock.write(`\r\n0\r\n\r\n`);
      });
      let raw = '';
      sock.on('data', (d) => { raw += d.toString('utf8'); });
      sock.on('end', () => resolve(raw));
      sock.on('close', () => resolve(raw));
      sock.on('error', reject);
    });
    assert.match(streamedStatus, /^HTTP\/1\.1 413 /);
    assert.match(streamedStatus, /"code":"payload_too_large"/);

    // P2-3: GET /api/v1/node twice returns identical cached summary
    const n1 = await ctx.call('/api/v1/node');
    const n2 = await ctx.call('/api/v1/node');
    assert.equal(n1.status, 200);
    assert.deepEqual(n1.body.swarms, n2.body.swarms);
  } finally {
    await teardown(ctx, null);
  }
});
