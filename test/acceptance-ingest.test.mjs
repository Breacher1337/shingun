import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { buildZip } from './fixtures/zip-fixture.mjs';
import { ingestChallenge, targetMarkdown } from '../src/ingest.mjs';
import { workerSystemPrompt } from '../src/worker.mjs';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- fixtures -----------------------------------------------------------------

function tarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'latin1');
  header.write((content.length).toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write('0', 156, 'latin1'); // regular file
  return Buffer.concat([header, Buffer.from(content, 'utf8'), Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

function tarGzip(entries) {
  const body = Buffer.concat(entries.flatMap(([n, c]) => [tarEntry(n, c)]));
  return gzipSync(Buffer.concat([body, Buffer.alloc(1024)]));
}

async function serveOnce(routes) {
  const srv = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { srv, url: (p) => `http://127.0.0.1:${port}${p}` };
}

const ws = () => tmpWorkspace('ingest-');

// --- tests ---------------------------------------------------------------------

test('ingest: download extracts a tar.gz into a normalized base repo', async () => {
  const dir = await ws();
  const { srv, url } = await serveOnce({
    '/dist.tar.gz': tarGzip([['README.md', '# packed challenge\nflag hint inside\n'], ['src/app.py', 'print("ok")\n']])
  });
  try {
    const ing = await ingestChallenge({ source: 'download', value: url('/dist.tar.gz'), challengesDir: dir });
    const read = await fs.readFile(path.join(ing.baseDir, 'README.md'), 'utf8');
    assert.match(read, /packed challenge/);
    const py = await fs.readFile(path.join(ing.baseDir, 'src/app.py'), 'utf8');
    assert.match(py, /print/);
    assert.ok(await fs.stat(path.join(ing.baseDir, '.git')).then(() => true).catch(() => false), 'git-normalized base');
    assert.ok(ing.fileCount >= 2, 'fileCount covers extraction');
  } finally {
    srv.close();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ingest: download stores a single plain file as the artifact', async () => {
  const dir = await ws();
  const { srv, url } = await serveOnce({ '/prompt.txt': Buffer.from('the challenge is in there\n') });
  try {
    const ing = await ingestChallenge({ source: 'download', value: url('/prompt.txt'), challengesDir: dir });
    const stored = await fs.readFile(path.join(ing.baseDir, 'prompt.txt'), 'utf8');
    assert.match(stored, /challenge is in there/);
  } finally {
    srv.close();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ingest: zip extracts — a CRC-verified local-header walk, no more refusal', async () => {
  const dir = await ws();
  const { srv, url } = await serveOnce({
    '/pico.zip': buildZip([
      ['README.md', '# picocrypt\nthe flag format is picoCTF{...}\n'],
      ['src/enc.py', 'print("x")\n']
    ])
  });
  try {
    const ing = await ingestChallenge({ source: 'download', value: url('/pico.zip'), challengesDir: dir });
    const read = await fs.readFile(path.join(ing.baseDir, 'README.md'), 'utf8');
    assert.match(read, /picocrypt/);
    const py = await fs.readFile(path.join(ing.baseDir, 'src/enc.py'), 'utf8');
    assert.match(py, /print/);
    assert.ok(await fs.stat(path.join(ing.baseDir, '.git')).then(() => true).catch(() => false), 'git-normalized base');

    // A corrupted byte anywhere in stored data must fail its CRC check.
    const badZip = Buffer.from(buildZip([['evil.txt', 'payload that will be corrupted']]));
    badZip[badZip.length - 4] ^= 0xFF;
    await assert.rejects(
      () => ingestChallenge({ source: 'upload', value: { data: badZip, filename: 'bad.zip' }, challengesDir: dir }),
      (e) => e.code === 'ingest_zip_corrupt' && /CRC/.test(e.message)
    );

    // Zip-slip: an entry escaping the root is refused by name.
    const slip = buildZip([['../escape.txt', 'nope']]);
    await assert.rejects(
      () => ingestChallenge({ source: 'upload', value: { data: slip, filename: 'slip.zip' }, challengesDir: dir }),
      (e) => e.code === 'ingest_zip_corrupt' && /escapes the archive root/.test(e.message)
    );
  } finally {
    srv.close();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ingest: a downloaded picoCTF zip lands via the CLI path too', async () => {
  const dir = await ws();
  try {
    const file = path.join(dir, 'pico-dl.zip');
    await fs.writeFile(file, buildZip([['chal/challenge.py', 'flag = "picoCTF{local}"\n']]));
    const ing = await ingestChallenge({ source: 'path', value: file, challengesDir: dir });
    const read = await fs.readFile(path.join(ing.baseDir, 'chal/challenge.py'), 'utf8');
    assert.match(read, /picoCTF\{local\}/);
    assert.ok(await fs.stat(path.join(ing.baseDir, '.git')).then(() => true).catch(() => false), 'normalized');
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ingest: downloads are capped — a hostile URL cannot flood the disk', async () => {
  const dir = await ws();
  const { srv, url } = await serveOnce({ '/big.tar.gz': tarGzip([['blob.bin', randomBytes(4096).toString('latin1')]]) });
  try {
    await assert.rejects(
      () => ingestChallenge({ source: 'download', value: url('/big.tar.gz'), challengesDir: dir, maxBytes: 1024 }),
      (e) => e.code === 'ingest_too_large'
    );
  } finally {
    srv.close();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ingest: a target rides any source, and a pure live-web challenge stands alone', async () => {
  const dir = await ws();
  const target = { url: 'http://127.0.0.1:8000/c/sqli/', note: 'the storefront login' };
  try {
    const ing = await ingestChallenge({ source: 'none', challengesDir: dir, target });
    const md = await fs.readFile(path.join(ing.baseDir, 'TARGET.md'), 'utf8');
    assert.match(md, new RegExp(target.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(md, /attack it over HTTP/);
    assert.equal(ing.target.url, target.url);

    // Worker prompts carry the target; a file-only challenge says so too.
    const prompt = workerSystemPrompt({
      persona: 'web-recon', strategyPrompt: 's', digestText: null, flagFormat: null,
      notesPath: '/n', toolsDir: '/t',
      config: { worker: { commandTimeoutSec: 60 } }, target
    });
    assert.match(prompt, /Live target/);
    assert.match(prompt, new RegExp('8000'));
    const bare = workerSystemPrompt({
      persona: 'web-recon', strategyPrompt: 's', digestText: null, flagFormat: null,
      notesPath: '/n', toolsDir: '/t', config: { worker: { commandTimeoutSec: 60 } }
    });
    assert.match(bare, /None — this challenge lives entirely in the files/);

    assert.ok(targetMarkdown(target).includes(target.url));
    await assert.rejects(
      () => ingestChallenge({ source: 'none', challengesDir: dir, target: { url: 'ftp://nope' } }),
      (e) => /target\.url must be http\(s\)/i.test(e.message)
    );

    // nc-class challenges: tcp://host:port targets are first-class; the
    // worker prompt switches from HTTP advice to raw-TCP client advice.
    const tcpTarget = { url: 'tcp://xebec.example.net:10071', note: 'two printers, one private' };
    const ingTcp = await ingestChallenge({ source: 'none', challengesDir: dir, target: tcpTarget });
    const mdTcp = await fs.readFile(path.join(ingTcp.baseDir, 'TARGET.md'), 'utf8');
    assert.match(mdTcp, /tcp:\/\/xebec\.example\.net:10071/);
    assert.match(mdTcp, /two printers, one private/);
    const promptTcp = workerSystemPrompt({
      persona: 'web-recon', strategyPrompt: 's', digestText: null, flagFormat: null,
      notesPath: '/n', toolsDir: '/t',
      config: { worker: { commandTimeoutSec: 60 } }, target: tcpTarget
    });
    assert.match(promptTcp, /RAW TCP/);
    assert.doesNotMatch(promptTcp, /attack it over HTTP/);
    await assert.rejects(
      () => ingestChallenge({ source: 'none', challengesDir: dir, target: { url: 'tcp://no-port.example.net' } }),
      (e) => /tcp:\/\/<host>:<port>/i.test(e.message)
    );
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('api: POST /api/v1/challenges accepts a pure live-web target challenge', async () => {
  const wr = await tmpWorkspace('ingest-api-');
  const loaded = await loadConfig({ file: path.join(ROOT, 'test', 'fixtures', 'test-config.json'), profile: 'low-power' });
  const config = structuredClone(loaded.config);
  config.roles = { master: { provider: 'mock' }, worker: { provider: 'mock' }, oracle: null };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, wr), env: { ...loaded.env }, bus });
  const srv = await startServer({
    config, env: { ...loaded.env }, orchestrator: orch, bus,
    workspaceDir: wr, envFile: path.join(wr, '.env'),
    webDir: path.join(ROOT, 'web'), configFile: path.join(wr, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const made = await call('/api/v1/challenges', {
      method: 'POST',
      body: { title: 'Legacy Login', target: { url: 'http://127.0.0.1:8000/c/sqli/' }, hint: 'v2.3-debug login' }
    });
    assert.equal(made.status, 201, 'pure live-web challenge registers');
    assert.ok(made.body.challengeId);

    const meta = await call(`/api/v1/challenges/${made.body.challengeId}`);
    assert.equal(meta.body.sourceType, 'none');
    assert.equal(meta.body.target.url, 'http://127.0.0.1:8000/c/sqli/');
    assert.equal(meta.body.title, 'Legacy Login');
    assert.equal(meta.body.hint, 'v2.3-debug login');

    const bad = await call('/api/v1/challenges', {
      method: 'POST', body: { target: { url: 'not-a-url' } }
    });
    assert.equal(bad.status, 400);

    const tcpMade = await call('/api/v1/challenges', {
      method: 'POST',
      body: { title: 'Secure Printer', target: { url: 'tcp://127.0.0.1:10071', note: 'nc service' } }
    });
    assert.equal(tcpMade.status, 201, 'API accepts tcp:// target without http-ism regression');
    const tcpMeta = await call(`/api/v1/challenges/${tcpMade.body.challengeId}`);
    assert.equal(tcpMeta.body.target.url, 'tcp://127.0.0.1:10071');
  } finally {
    await srv.close();
    fs.rm(wr, { recursive: true, force: true }).catch(() => {});
  }
});

test('api: POST /api/v1/challenges accepts a raw zip upload (the picoCTF door)', async () => {
  const wr = await tmpWorkspace('ingest-upload-');
  const loaded = await loadConfig({ file: path.join(ROOT, 'test', 'fixtures', 'test-config.json'), profile: 'low-power' });
  const config = structuredClone(loaded.config);
  config.roles = { master: { provider: 'mock' }, worker: { provider: 'mock' }, oracle: null };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, wr), env: { ...loaded.env }, bus });
  const srv = await startServer({
    config, env: { ...loaded.env }, orchestrator: orch, bus,
    workspaceDir: wr, envFile: path.join(wr, '.env'),
    webDir: path.join(ROOT, 'web'), configFile: path.join(wr, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const zipBytes = buildZip([
    ['README.md', '# picocrypt\n'],
    ['enc.py', 'flag = "picoCTF{uploaded}"\n']
  ]);
  try {
    const res = await fetch(`${base}/api/v1/challenges?title=picocrypt&hint=vigenere&target=${encodeURIComponent('http://127.0.0.1:8000/c/sqli/')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-shingun-filename': 'picocrypt.zip' },
      body: zipBytes
    });
    assert.equal(res.status, 201, 'raw upload registers a challenge');
    const out = await res.json();
    assert.equal(out.filename, 'picocrypt.zip');
    assert.ok(out.uploadedBytes === zipBytes.length);
    assert.ok(out.fileCount >= 2, 'zip entries extracted');

    const meta = await fetch(`${base}/api/v1/challenges/${out.challengeId}`).then((r) => r.json());
    assert.equal(meta.title, 'picocrypt');
    assert.equal(meta.sourceValue, 'picocrypt.zip');
    assert.equal(meta.sourceType, 'upload');
    assert.equal(meta.target.url, 'http://127.0.0.1:8000/c/sqli/');
    assert.equal(meta.hint, 'vigenere');
  } finally {
    await srv.close();
    fs.rm(wr, { recursive: true, force: true }).catch(() => {});
  }
});

test('P1-5: zip bomb exceeding maxExtractedBytes fails with ingest_too_large and server stays healthy', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const wr = await tmpWorkspace('ingest-bomb-');
  const loaded = await loadConfig({ file: path.join(ROOT, 'test', 'fixtures', 'test-config.json'), profile: 'low-power' });
  const config = structuredClone(loaded.config);
  config.roles = { master: { provider: 'mock' }, worker: { provider: 'mock' }, oracle: null };
  config.ingest = { maxExtractedBytes: 1024 * 1024, maxExtractedEntries: 20000 };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, wr), env: { ...loaded.env }, bus });
  const srv = await startServer({
    config, env: { ...loaded.env }, orchestrator: orch, bus,
    workspaceDir: wr, envFile: path.join(wr, '.env'),
    configFile: path.join(wr, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;

  // Build a zip with a 5 MB deflated entry (compresses to ~5 KB)
  const raw = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const comp = deflateRawSync(raw);
  const nameBuf = Buffer.from('bomb.bin', 'utf8');
  const hdr = Buffer.alloc(30);
  hdr.writeUInt32LE(0x04034b50, 0);
  hdr.writeUInt16LE(20, 4);
  hdr.writeUInt16LE(0, 6);
  hdr.writeUInt16LE(8, 8);
  hdr.writeUInt32LE(0, 14); // CRC irrelevant since maxOutputLength trips first
  hdr.writeUInt32LE(comp.length, 18);
  hdr.writeUInt32LE(raw.length, 22);
  hdr.writeUInt16LE(nameBuf.length, 26);
  const bombZip = Buffer.concat([hdr, nameBuf, comp]);

  try {
    const res = await fetch(`${base}/api/v1/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-shingun-filename': 'bomb.zip' },
      body: bombZip
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'ingest_too_large');
    const leftover = await fs.readdir(path.join(wr, 'challenges'));
    assert.equal(leftover.length, 0, 'failed ingest must not leave empty challenge directory');

    // Follow-up valid ingest succeeds on the same server instance
    const okZip = buildZip([['ok.txt', 'hello\n']]);
    const ok = await fetch(`${base}/api/v1/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-shingun-filename': 'ok.zip' },
      body: okZip
    });
    assert.equal(ok.status, 201);
  } finally {
    await srv.close();
    fs.rm(wr, { recursive: true, force: true }).catch(() => {});
  }
});
