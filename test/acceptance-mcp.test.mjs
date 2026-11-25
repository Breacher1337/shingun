import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildZip } from './fixtures/zip-fixture.mjs';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { replayFile } from '../src/store.mjs';
import { tmpWorkspace, NODE, BIN } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');

/** Start a local silent/menu TCP challenge server for tcp_session tests. */
async function startMockTcpChallenge() {
  const srv = net.createServer((sock) => {
    sock.write('MENU:\n1) print\n2) quit\n> ');
    sock.on('data', (chunk) => {
      const line = chunk.toString('utf8').trim();
      if (line === '1') sock.write('flag=shingun{tcp_ok}\n> ');
      else if (line === '2') { sock.write('bye\n'); sock.end(); }
      else sock.write('unknown\n> ');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

test('mcp stdio: initialize, tools/list, zip ingest, read/search, tcp_session, submit_flag, swarm_run/status', async () => {
  const ws = await tmpWorkspace('mcp-stdio-');
  const tcp = await startMockTcpChallenge();
  const child = spawn(NODE, [BIN, 'mcp', '--config', TEST_CONFIG, '--workspace', ws], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout for ${method}`)); }, 20000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const callTool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(r.result, `tool ${name} returned result`);
    const parsed = JSON.parse(r.result.content[0].text);
    return { isError: Boolean(r.result.isError), data: parsed, raw: r.result.content[0].text };
  };

  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'shingun');

    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'ingest_challenge',
      'read_artifact',
      'search_artifacts',
      'submit_flag',
      'swarm_run',
      'swarm_status',
      'tcp_session'
    ]);

    // Ingest a picoCTF-style zip via base64 bytes + target.
    const zipBytes = buildZip([
      ['README.md', '# pico-test\nFind the hidden flag.\n'],
      ['src/chal.py', 'FLAG = "shingun{zip_mcp_ok}"\n']
    ]);
    const ing = await callTool('ingest_challenge', {
      bytes: zipBytes.toString('base64'),
      filename: 'pico.zip',
      title: 'pico-test',
      flagFormatRegex: 'shingun\\{[^}]+\\}',
      target: { url: `tcp://127.0.0.1:${tcp.port}`, note: 'menu on connect' }
    });
    assert.equal(ing.isError, false);
    const challengeId = ing.data.challengeId;
    assert.ok(challengeId);

    // read_artifact + jail check
    const read = await callTool('read_artifact', { challengeId, path: 'src/chal.py' });
    assert.match(read.data.content, /shingun\{zip_mcp_ok\}/);

    const escapeAttempt = await rpc('tools/call', {
      name: 'read_artifact',
      arguments: { challengeId, path: '../../challenge.json' }
    });
    assert.equal(escapeAttempt.result.isError, true, 'path jail blocks traversal');

    // search_artifacts
    const search = await callTool('search_artifacts', { challengeId, pattern: 'zip_mcp_ok' });
    assert.equal(search.data.hits.length, 1);
    assert.equal(search.data.hits[0].path, 'src/chal.py');

    // tcp_session persistent connect -> send -> close
    const conn = await callTool('tcp_session', { action: 'connect', host: '127.0.0.1', port: tcp.port, challengeId });
    assert.equal(conn.data.connected, true);
    assert.match(conn.data.banner, /MENU:/);
    const sid = conn.data.sid;

    const sent = await callTool('tcp_session', { action: 'send', sid, data: '1\n' });
    assert.match(sent.data.data, /shingun\{tcp_ok\}/);

    const closed = await callTool('tcp_session', { action: 'close', sid });
    assert.equal(closed.data.closed, true);

    // submit_flag recorded into event store
    const sub = await callTool('submit_flag', { challengeId, flag: 'shingun{tcp_ok}', reasoning: 'from menu 1' });
    assert.equal(sub.data.recorded, true);
    assert.equal(sub.data.formatMatch, 'match');

    // Verify all MCP actions landed in the event store
    const mcpEvents = await replayFile(path.join(ws, 'challenges', challengeId, 'events', 'mcp.jsonl'));
    assert.ok(mcpEvents.some((e) => e.type === 'challenge.ingested'));
    assert.ok(mcpEvents.some((e) => e.type === 'mcp.artifact.read'));
    assert.ok(mcpEvents.some((e) => e.type === 'mcp.artifact.search'));
    assert.ok(mcpEvents.some((e) => e.type === 'mcp.tcp'));
    assert.ok(mcpEvents.some((e) => e.type === 'flag.found' && e.data.flag === 'shingun{tcp_ok}'));

    // Optional swarm_run + swarm_status via MCP (fixture path)
    const easyIng = await callTool('ingest_challenge', {
      path: path.join(ROOT, 'test', 'fixtures', 'challenge-easy')
    });
    const sw = await callTool('swarm_run', { challengeId: easyIng.data.challengeId, workers: 2 });
    assert.match(sw.data.swarmId, /^sw-/);
    const st = await callTool('swarm_status', { swarmId: sw.data.swarmId });
    assert.equal(st.data.swarmId, sw.data.swarmId);
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
    await new Promise((r) => { const t = setTimeout(r, 1000); child.once('close', () => { clearTimeout(t); r(); }); });
    tcp.srv.close();
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('mcp streamable-http: /mcp works over localhost HTTP and respects token + host guards', async () => {
  const ws = await tmpWorkspace('mcp-http-');
  const token = 't-' + 'm'.repeat(40);
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power', envFile: path.join(ws, '.env') });
  const mergedEnv = { ...env, SHINGUN_TOKEN: token };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: mergedEnv, bus });
  const srv = await startServer({ config, env: mergedEnv, orchestrator: orch, bus, workspaceDir: ws });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;

  try {
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauth.status, 401, 'gated /mcp requires bearer token');

    const postMcp = async (msg) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(msg)
      });
      return { status: res.status, body: res.status === 202 ? null : await res.json() };
    };

    const init = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-03-26');

    const notif = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif.status, 202);

    const zipPath = path.join(ws, 'sample.zip');
    await fs.writeFile(zipPath, buildZip([['note.txt', 'picoCTF{http_mcp}\n']]));
    const ing = await postMcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ingest_challenge', arguments: { path: zipPath } }
    });
    const ingData = JSON.parse(ing.body.result.content[0].text);
    const read = await postMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'read_artifact', arguments: { challengeId: ingData.challengeId, path: 'note.txt' } }
    });
    assert.match(JSON.parse(read.body.result.content[0].text).content, /picoCTF\{http_mcp\}/);
  } finally {
    for (const [id] of orch.swarms) await orch.stop(id, 'test-teardown').catch(() => {});
    await srv.close();
    fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
});
