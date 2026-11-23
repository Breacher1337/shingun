import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace, NODE, BIN } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHALLENGE = path.join(ROOT, 'test', 'fixtures', 'challenge-easy');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');
const TOKEN = 't-' + 'a'.repeat(40);

async function boot() {
  const ws = await tmpWorkspace('serve-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
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
  const call = async (p, { method = 'GET', body, auth = true } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
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

    // The bare 401 entry page offers the tokenized URL form (no data in it).
    const gate = await fetch(ctx.base + '/');
    assert.equal(gate.status, 401);
    assert.match(gate.headers.get('content-type') ?? '', /text\/html/);
    const gateBody = await gate.text();
    assert.match(gateBody, /token/i);
    assert.ok(!gateBody.includes('worker'), 'gate page leaks no swarm data');

    // Wrong query token still refused.
    const badQuery = await fetch(`${ctx.base}/?token=nope`);
    assert.equal(badQuery.status, 401);
    await badQuery.body.cancel().catch(() => {});

    // Authorized static shell: html + assets with no-store + content types.
    const html = await ctx.call('/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.match(html.text, /dashboard\.mjs/);

    const css = await ctx.call('/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(css.headers.get('cache-control'), 'no-store');

    const js = await ctx.call('/dashboard.mjs');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal(js.headers.get('cache-control'), 'no-store');

    // Server binds localhost only.
    assert.equal(ctx.srv.server.address().address, '127.0.0.1');
  } finally {
    await teardown(ctx);
  }
});

test('acceptance 2b: challenge → swarm visible end-to-end over HTTP + SSE', async (t) => {
  const ctx = await boot();
  let swarmId = null;
  try {
    // Register the challenge over HTTP.
    const bad = await ctx.call('/api/challenges', { method: 'POST', body: { source: 'x', value: '' } });
    assert.equal(bad.status, 400);
    const ch = await ctx.call('/api/challenges', {
      method: 'POST',
      body: { source: 'path', value: CHALLENGE, flagFormatRegex: 'shingun\\{[^}]*\\}' }
    });
    assert.equal(ch.status, 200);
    const challengeId = ch.body.challengeId;
    assert.ok(challengeId);

    const bad2 = await ctx.call(`/api/challenges/${challengeId}/swarm`, { method: 'POST', body: { workers: 99 } });
    assert.equal(bad2.status, 200); // clamps to concurrency caps, not an error
    assert.ok(bad2.body.swarmId);
    swarmId = bad2.body.swarmId;

    // Unknown swarm reads are 404.
    const unknown = await ctx.call('/api/swarms/sw-void');
    assert.equal(unknown.status, 404);

    // SSE backlog replays from event 0 for auth'd subscribers.
    const sse = await fetch(`${ctx.base}/api/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);

    // A second, later subscriber also gets the full backlog replay.
    const back2 = await fetch(`${ctx.base}/api/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const early = await sseCollect(back2, (evs) => evs.some((e) => e.type === 'worker.spawn'), 5000);
    assert.ok(early.events.find((e) => e.type === 'challenge.ingested'), 'backlog starts from event 0');
    assert.ok(early.events.find((e) => e.type === 'master.triage'));
    await back2.body.cancel().catch(() => {});

    // Swarm state reconstructs via replay: poll to solved.
    const solved = await waitFor(async () => {
      const snap = await ctx.call(`/api/swarms/${swarmId}`);
      assert.equal(snap.status, 200);
      return ['solved', 'stopped', 'capped'].includes(snap.body.status) ? snap.body : null;
    }, 60000);
    assert.ok(solved, `swarm reached a terminal state (got: ${JSON.stringify(solved)}`);
    assert.equal(solved.status, 'solved');
    assert.equal(solved.flags[0].flag, 'shingun{m0ck_fl4g}');
    assert.ok(solved.workers.length >= 1, 'workers are visible');
    assert.ok(solved.workers.every((w) => typeof w.persona === 'string'));
    assert.ok(solved.budget.usd > 0, 'usage was accumulated');
    assert.ok(solved.caps.perSwarmUsd > 0, 'caps are exported for meters');
    assert.ok(solved.lastSeq >= 1, 'replay position is exported');

    // The live stream also carries the flag and the final status.
    const stream = await sseCollect(sse, (evs) =>
      evs.some((e) => e.type === 'flag.found') && evs.some((e) => e.type === 'swarm.update' && e.data.status === 'solved'), 30000);
    assert.ok(stream.events.find((e) => e.type === 'flag.found' && e.data.flag === 'shingun{m0ck_fl4g}'), 'flag.found streamed');
    assert.ok(stream.events.find((e) => e.type === 'usage.tick'), 'usage ticks streamed');
    await sse.body.cancel().catch(() => {});

    // Flag trophy attribution.
    const snap2 = await ctx.call(`/api/swarms/${swarmId}`);
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
    const ch = await ctx.call('/api/challenges', { method: 'POST', body: { source: 'path', value: CHALLENGE } });
    const sw = await ctx.call(`/api/challenges/${ch.body.challengeId}/swarm`, { method: 'POST', body: { workers: 2 } });
    swarmId = sw.body.swarmId;

    // The directive must run while the swarm is live (the swarm is still in
    // its spawn wave: worktree checkouts take far longer than this round-trip).
    const sse = await fetch(`${ctx.base}/api/events?swarm=${swarmId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const res = await ctx.call('/api/master/message', {
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
      const snap = await ctx.call(`/api/swarms/${swarmId}`);
      const chat = snap.body.masterChat ?? [];
      return chat.length >= 2 ? chat : null;
    }, 20000);
    assert.ok(withStatus.every((m) => typeof m.text === 'string'));
    const replied = withStatus[1];
    assert.equal(replied.direction, 'master');
    await sse.body.cancel().catch(() => {});

    // Steering a live worker queues a note, unknown ids are 404.
    const snapA = await ctx.call(`/api/swarms/${swarmId}`);
    const wid = snapA.body.workers[0]?.id;
    if (wid) {
      const steer = await ctx.call(`/api/swarms/${swarmId}/workers/${wid}/message`, {
        method: 'POST', body: { text: 'prioritize the README' }
      });
      assert.equal(steer.status, 200);
      assert.equal(steer.body.queued, true);
    }
    const steerBad = await ctx.call(`/api/swarms/${swarmId}/workers/w-void/message`, {
      method: 'POST', body: { text: 'x' }
    });
    assert.equal(steerBad.status, 404);

    // Diff endpoint: 200 with shape after settle, 404 for a worker that never ran.
    await ctx.orch.swarms.get(swarmId).done.catch(() => {});
    const diffWid = (await ctx.call(`/api/swarms/${swarmId}`)).body.workers[0].id;
    const diff = await waitFor(async () => {
      const d = await ctx.call(`/api/swarms/${swarmId}/workers/${diffWid}/diff`);
      return d.status === 200 ? d : null;
    }, 15000);
    assert.ok(diff, 'diff is captured once the worker settles');
    assert.ok(diff.body.stats === null || typeof diff.body.stats.files === 'number', 'diff stats shape');
    const diffNone = await ctx.call(`/api/swarms/${swarmId}/workers/w-none/diff`);
    assert.equal(diffNone.status, 404);

    // Stop route: terminal swarm reports already-stopped; unknown is 404.
    const stop = await ctx.call(`/api/swarms/${swarmId}/stop`, { method: 'POST', body: {} });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopped, true);
    const stopUnknown = await ctx.call('/api/swarms/sw-void/stop', { method: 'POST', body: {} });
    assert.equal(stopUnknown.status, 404);
  } finally {
    await teardown(ctx, swarmId);
  }
});

test('acceptance 2e: provider key scan + provisioning (values never echo)', async () => {
  const ctx = await boot();
  try {
    // Scan: metadata + booleans only — never key values.
    const scan = await ctx.call('/api/providers');
    assert.equal(scan.status, 200);
    assert.ok(scan.body.providers.mistral, 'mistral listed');
    assert.equal(scan.body.providers.mistral.type, 'openai-compat');
    assert.equal(scan.body.providers.mistral.apiKeyEnv, 'MISTRAL_API_KEY');
    assert.equal(scan.body.providers.mock.hasKey, null, 'mock is keyless by design');
    assert.ok(typeof scan.body.providers.mistral.hasKey === 'boolean', 'hasKey is a boolean');

    // Validation: weak keys and unknown providers are refused.
    const bad = await ctx.call('/api/provider-key', { method: 'POST', body: { provider: 'mistral', apiKey: 'short' } });
    assert.equal(bad.status, 400, 'weak key refused');
    const unknown = await ctx.call('/api/provider-key', { method: 'POST', body: { provider: 'void', apiKey: 'x'.repeat(12) } });
    assert.equal(unknown.status, 400, 'unknown provider refused');
    const noKeyProvider = await ctx.call('/api/provider-key', { method: 'POST', body: { provider: 'mock', apiKey: 'x'.repeat(12) } });
    assert.equal(noKeyProvider.status, 400, 'keyless provider refused');

    // Provision: live env, durable .env, role activation, persisted config.
    const KEY = 'sk-provision-0123456789abcdef';
    const ok = await ctx.call('/api/provider-key', { method: 'POST', body: { provider: 'mistral', apiKey: KEY, activate: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.hasKey, true);
    assert.equal(ok.body.activated, true);
    assert.equal(ok.body.persisted, true);
    assert.ok(!JSON.stringify(ok.body).includes(KEY), 'response never echoes the key');

    const after = await ctx.call('/api/providers');
    assert.equal(after.body.providers.mistral.hasKey, true, 'key visible as boolean');
    assert.equal(after.body.roles.master.provider, 'mistral', 'master role activated');
    assert.equal(after.body.roles.worker.provider, 'mistral', 'worker role activated');
    assert.ok(!JSON.stringify(after.body).includes(KEY), 'scan never leaks the key');

    const envText = await fs.readFile(path.join(ctx.ws, '.env'), 'utf8');
    assert.match(envText, new RegExp(`^MISTRAL_API_KEY=${KEY}$`, 'm'), 'key persisted to .env');
    const cfgText = await fs.readFile(path.join(ctx.ws, 'config.json'), 'utf8');
    assert.match(cfgText, /"provider"\s*:\s*"mistral"/, 'roles persisted to config file');
  } finally {
    await teardown(ctx);
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
    const dashboardUrl = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const m = /dashboard: (\S+)/.exec(out);
        if (m) { clearInterval(timer); resolve(m[1]); }
        else if (Date.now() - t0 > 25000) {
          clearInterval(timer);
          reject(new Error(`serve did not print its dashboard url: ${out.slice(0, 500)}`));
        }
      }, 100);
    });
    assert.match(dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

    const dash = await fetch(dashboardUrl);
    assert.equal(dash.status, 200);
    assert.match(await dash.text(), /shingun/);

    // Same host without the token: still gated.
    const gate = await fetch(new URL('/', dashboardUrl));
    assert.equal(gate.status, 401);
    await gate.body.cancel().catch(() => {});
  } finally {
    child.kill('SIGKILL');
    child.stdout.destroy?.();
    child.stderr.destroy?.();
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
