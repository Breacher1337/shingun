import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { getProvider, resolveApiKey } from '../src/providers/registry.mjs';
import { preflightRoleProviders } from '../src/providers/preflight.mjs';
import { tmpWorkspace } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');
const TOKEN = 't-' + 'a'.repeat(40);

const COMPAT = {
  type: 'openai-compat', baseUrl: 'http://provider.test/v1',
  apiKeyEnv: 'MISTRAL_API_KEY', defaultModel: 'model-x',
  pricePerMTok: { in: 1, out: 2 }
};

// The fallback chain reads process.env as a last resort — scrub both vars so
// these units stay deterministic even on a keyed operator shell.
function withCleanKeyEnv(fn) {
  return async () => {
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, MISTRAL_API_KEY: process.env.MISTRAL_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v; else delete process.env[k];
      }
    }
  };
}

function fakeFetch(captured) {
  return async (url, opts) => {
    captured.push({ url, headers: opts?.headers ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    };
  };
}

test('universal key: entry var wins, OPENAI_API_KEY fills, wire carries it', withCleanKeyEnv(async () => {
  assert.equal(resolveApiKey(COMPAT, { MISTRAL_API_KEY: 'sk-specific', OPENAI_API_KEY: 'sk-universal' }), 'sk-specific', 'the entry var wins');
  assert.equal(resolveApiKey(COMPAT, { OPENAI_API_KEY: 'sk-universal' }), 'sk-universal', 'universal fills a gap');
  assert.equal(resolveApiKey({ ...COMPAT, apiKeyEnv: null }, { OPENAI_API_KEY: 'sk-universal' }), 'sk-universal', 'a varless entry reads the universal');
  assert.equal(resolveApiKey(COMPAT, {}), '', 'nothing set resolves empty');

  const captured = [];
  const config = { roles: { worker: { provider: 'mistral' } }, providers: { mistral: COMPAT } };
  const provider = getProvider(config, 'worker', {
    env: { OPENAI_API_KEY: 'sk-universal' },
    fetchFn: fakeFetch(captured)
  });
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(captured[0].headers.authorization, 'Bearer sk-universal', 'the wire carries the universal key');
}));

test('universal key: preflight accepts the universal and keeps refusing nonsense', withCleanKeyEnv(async () => {
  const config = {
    roles: { master: { provider: 'mistral' }, worker: { provider: 'mistral' } },
    providers: { mistral: COMPAT }
  };
  const missing = preflightRoleProviders(config, {});
  assert.equal(missing?.code, 'provider_key_missing', 'no key anywhere is refused');
  assert.match(missing.message, /OPENAI_API_KEY/, 'the refusal names the universal var');

  const universal = preflightRoleProviders(config, { OPENAI_API_KEY: 'sk-universal' });
  assert.equal(universal, null, 'the universal key satisfies preflight');

  const nonsense = preflightRoleProviders(config, { OPENAI_API_KEY: 'https://console.example/keys' });
  assert.equal(nonsense?.code, 'provider_key_invalid', 'a pasted URL is still nonsense');

  const specific = preflightRoleProviders(config, { MISTRAL_API_KEY: 'sk-specific' });
  assert.equal(specific, null, 'the entry var still satisfies preflight');
}));

test('universal key: settings provisioning on a varless entry writes OPENAI_API_KEY', withCleanKeyEnv(async () => {
  const ws = await tmpWorkspace('provider-key-');
  const loaded = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const config = structuredClone(loaded.config);
  config.roles = { master: { provider: 'mock' }, worker: { provider: 'mock' }, oracle: null };
  // A varless compat entry: the switch-to-anything-else shape.
  config.providers = {
    ...config.providers,
    universal: {
      type: 'openai-compat', baseUrl: 'http://provider.test/v1',
      defaultModel: 'model-x', pricePerMTok: { in: 1, out: 2 }
    }
  };
  const env = { ...loaded.env };
  delete env.OPENAI_API_KEY;
  delete env.MISTRAL_API_KEY;
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: { ...env, SHINGUN_TOKEN: TOKEN }, bus });
  const srv = await startServer({
    config, env: { ...env, SHINGUN_TOKEN: TOKEN }, orchestrator: orch, bus,
    workspaceDir: ws, envFile: path.join(ws, '.env'),
    webDir: path.join(ROOT, 'web'), configFile: path.join(ws, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, body: data, text };
  };
  try {
    // Scan: the varless entry reports the universal var and a presence boolean.
    const scan = await call('/api/v1/providers');
    assert.equal(scan.status, 200);
    assert.equal(scan.body.providers.universal.apiKeyEnv, 'OPENAI_API_KEY', 'scan names the universal var');
    assert.equal(scan.body.providers.universal.hasKey, false, 'no key yet');

    // Provision: a paste on the varless entry lands on the universal var.
    const put = await call('/api/v1/providers/universal/key', { method: 'PUT', body: { apiKey: 'sk-universal-xx' } });
    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);
    assert.equal(put.body.persisted, true, 'durable in the operator .env');

    const rescan = await call('/api/v1/providers');
    assert.equal(rescan.body.providers.universal.hasKey, true, 'key present after the paste');

    const envText = await fs.readFile(path.join(ws, '.env'), 'utf8');
    assert.match(envText, /^OPENAI_API_KEY=/m, 'the durably written var is the universal one');

    // Keyless-by-design entries are still refused keys.
    const mockPut = await call('/api/v1/providers/mock/key', { method: 'PUT', body: { apiKey: 'x'.repeat(12) } });
    assert.equal(mockPut.status, 400, 'a mock entry still takes no API key');
  } finally {
    await srv.close();
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
}));

test('P1-8 & P1-9: openai-compat times out with provider_timeout and truncates outbound transcript bodies', async () => {
  const { createOpenaiCompat } = await import('../src/providers/openai-compat.mjs');
  const { createBudgetGuard } = await import('../src/budget.mjs');
  const ws = await tmpWorkspace('prov-p1-');
  const logSink = path.join(ws, 'outbound.jsonl');
  const guard = createBudgetGuard({ usdCap: 5.0 });

  // P1-8: never-resolving fetchFn that honors AbortSignal times out -> provider_timeout, no budget recorded
  let sawSignal = false;
  const hangingProv = createOpenaiCompat({
    baseUrl: 'http://provider.test/v1',
    apiKey: 'sk-test',
    defaultModel: 'm1',
    callTimeoutMs: 40,
    retryBaseMs: 10,
    fetchFn: (_url, opts) => new Promise((_resolve, reject) => {
      sawSignal = opts?.signal instanceof AbortSignal;
      const keepAlive = setTimeout(() => {}, 5000);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(opts.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    })
  });
  await assert.rejects(
    () => hangingProv.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e.code === 'provider_timeout'
  );
  assert.equal(sawSignal, true);
  assert.equal(guard.spent.tokens, 0);

  // P1-9: long messages truncated to transcriptBodyBytes with char/token estimates
  const okProv = createOpenaiCompat({
    baseUrl: 'http://provider.test/v1',
    apiKey: 'sk-test',
    defaultModel: 'm1',
    transcriptBodyBytes: 64,
    logSink,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    })
  });
  await okProv.chat({
    messages: [{ role: 'user', content: 'A'.repeat(500) }],
    meta: { worker: 'w-1', step: 1 }
  });
  const lines = (await fs.readFile(logSink, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const out = lines.find((l) => l.kind === 'openai-compat.outbound');
  assert.ok(out);
  assert.equal(out.meta.worker, 'w-1');
  assert.equal(out.messages[0].chars, 500);
  assert.equal(out.messages[0].estTokens, 125);
  assert.equal(out.messages[0].truncated, true);
  assert.ok(Buffer.byteLength(out.messages[0].content, 'utf8') < 160);
  fs.rm(ws, { recursive: true, force: true }).catch(() => {});
});
