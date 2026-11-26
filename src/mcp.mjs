import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { makeJail } from './jail.mjs';
import { locateSwarm, openEventStore, rebuildSwarmState, replayFile } from './store.mjs';
import { newId } from './util.mjs';

const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const MAX_READ_BYTES = 65536;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

function mcpError(code, message) {
  return Object.assign(new Error(message), { code });
}

export const MCP_TOOLS = [
  {
    name: 'ingest_challenge',
    description: 'Ingest a CTF challenge from a URL (git repo or .zip/.tar.gz download), local folder/file path, base64 upload bytes, and/or live target (http(s):// or tcp://host:port).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Git repository URL or archive (.zip/.tar.gz) download URL' },
        path: { type: 'string', description: 'Local folder, archive (.zip/.tar.gz), or single artifact file path' },
        bytes: { type: 'string', description: 'Base64-encoded file bytes for raw upload' },
        filename: { type: 'string', description: 'Filename for raw bytes upload (e.g. challenge.zip)' },
        title: { type: 'string', description: 'Optional challenge title' },
        hint: { type: 'string', description: 'Optional operator hint' },
        target: {
          description: 'Optional live service target ({url, note?} or URL string, http(s):// or tcp://host:port)',
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                url: { type: 'string' },
                note: { type: 'string' }
              },
              required: ['url']
            }
          ]
        },
        flagFormatRegex: { type: 'string', description: 'Optional flag regex' },
        categoryHint: { type: 'string', description: 'Optional category hint' }
      }
    }
  },
  {
    name: 'tcp_session',
    description: 'Persistent bidirectional TCP session (for silent nc-class CTF services). Actions: connect, send, recv, close, list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['connect', 'send', 'recv', 'close', 'list'] },
        sid: { type: 'string', description: 'Session id (required for send, recv, close)' },
        host: { type: 'string', description: 'Target host (required for connect)' },
        port: { type: 'integer', description: 'Target port 1..65535 (required for connect)' },
        data: { type: 'string', description: 'Payload to send (for send)' },
        encoding: { type: 'string', enum: ['utf8', 'base64', 'hex'], description: 'Encoding of data for send (default utf8)' },
        timeoutMs: { type: 'integer', description: 'Wait timeout in ms for banner/reply/recv' },
        challengeId: { type: 'string', description: 'Optional challengeId to attach TCP events to' }
      },
      required: ['action']
    }
  },
  {
    name: 'read_artifact',
    description: 'Read a file inside an ingested challenge base directory (path-jailed).',
    inputSchema: {
      type: 'object',
      properties: {
        challengeId: { type: 'string' },
        path: { type: 'string', description: 'Relative path inside the challenge base directory' },
        offset: { type: 'integer', description: 'Byte offset (default 0)' },
        maxBytes: { type: 'integer', description: 'Maximum bytes to read (default 65536)' }
      },
      required: ['challengeId', 'path']
    }
  },
  {
    name: 'search_artifacts',
    description: 'Search files inside an ingested challenge base directory by regex or substring.',
    inputSchema: {
      type: 'object',
      properties: {
        challengeId: { type: 'string' },
        pattern: { type: 'string', description: 'Regex pattern (case-insensitive)' },
        maxHits: { type: 'integer', description: 'Maximum matching lines (default 50)' }
      },
      required: ['challengeId', 'pattern']
    }
  },
  {
    name: 'submit_flag',
    description: 'Record a candidate or confirmed flag for a challenge into the event store.',
    inputSchema: {
      type: 'object',
      properties: {
        challengeId: { type: 'string' },
        flag: { type: 'string' },
        reasoning: { type: 'string' }
      },
      required: ['challengeId', 'flag']
    }
  },
  {
    name: 'swarm_run',
    description: 'Launch an optional headless worker swarm against an ingested challenge.',
    inputSchema: {
      type: 'object',
      properties: {
        challengeId: { type: 'string' },
        workers: { type: 'integer' }
      },
      required: ['challengeId']
    }
  },
  {
    name: 'swarm_status',
    description: 'Read live or replayed status for a swarm id.',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string' }
      },
      required: ['swarmId']
    }
  }
];

function normalizeTarget(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return { url: raw };
  return raw;
}

function isLikelyText(buf) {
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

export function createMcpServer({ orchestrator, bus, workspaceDir, config }) {
  const challengesDir = path.join(workspaceDir, 'challenges');
  const maxFileBytes = config?.mcp?.maxFileBytes ?? 64 * 1024 * 1024;
  const tcpMaxSessions = config?.tcp?.maxSessions ?? 16;
  const tcpMaxBufferBytes = (config?.tcp?.maxBufferMb ?? 1) * 1024 * 1024;
  const tcpIdleTtlMs = (config?.tcp?.idleTtlMin ?? 5) * 60 * 1000;
  const stores = new Map(); // filePath -> store promise
  const tcpSessions = new Map(); // sid -> session
  const tcpReaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of tcpSessions) {
      if (now - sess.lastActiveAt > tcpIdleTtlMs) {
        try { sess.socket.destroy(); } catch { /* ignore */ }
        sess.closed = true;
        tcpSessions.delete(sid);
        recordEvent(sess.challengeId, 'mcp.tcp', { action: 'evict', sid, reason: 'idle_ttl' }).catch(() => {});
      }
    }
  }, Math.min(tcpIdleTtlMs, 30_000));
  tcpReaper.unref?.();

  async function getStore(challengeId) {
    const key = challengeId ? `ch:${challengeId}` : 'console';
    if (!stores.has(key)) {
      const file = challengeId
        ? path.join(challengesDir, challengeId, 'events', 'mcp.jsonl')
        : path.join(workspaceDir, 'console', 'mcp.jsonl');
      stores.set(key, openEventStore(file, { swarmId: challengeId ? `mcp-${challengeId}` : 'mcp' }));
    }
    return stores.get(key);
  }

  function validateChallengeId(challengeId) {
    if (challengeId === undefined || challengeId === null || challengeId === '') return null;
    if (typeof challengeId !== 'string' || !/^[\w-]+$/.test(challengeId)) {
      throw mcpError('bad_request', 'challengeId must be a valid challenge id');
    }
    return challengeId;
  }

  async function recordEvent(challengeId, type, data) {
    const cid = validateChallengeId(challengeId);
    const store = await getStore(cid);
    const ev = await store.append({
      type,
      challenge: cid,
      swarm: null,
      worker: 'mcp',
      data
    });
    bus?.publish(ev);
    return ev;
  }

  async function requireChallenge(challengeId) {
    if (typeof challengeId !== 'string' || !/^[\w-]+$/.test(challengeId)) {
      throw mcpError('bad_request', 'challengeId must be a valid challenge id');
    }
    const chDir = path.join(challengesDir, challengeId);
    const baseDir = path.join(chDir, 'base');
    const exists = await fs.stat(baseDir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) throw mcpError('challenge_unknown', `unknown challenge ${challengeId}`);
    const meta = await fs.readFile(path.join(chDir, 'challenge.json'), 'utf8')
      .then((t) => JSON.parse(t))
      .catch(() => null);
    return { chDir, baseDir, meta };
  }

  function drainSession(sess) {
    const overflowed = Boolean(sess.overflowed);
    sess.overflowed = false;
    if (!sess.chunks.length) {
      sess.bufferedBytes = 0;
      return { data: '', dataBase64: '', overflowed };
    }
    const buf = Buffer.concat(sess.chunks);
    sess.chunks = [];
    sess.bufferedBytes = 0;
    return { data: buf.toString('utf8'), dataBase64: buf.toString('base64'), overflowed };
  }

  function waitForChunk(sess, timeoutMs, idleMs = 80) {
    if (sess.chunks.length || sess.closed) {
      return new Promise((resolve) => {
        if (sess.closed) return resolve(drainSession(sess));
        const t = setTimeout(() => resolve(drainSession(sess)), Math.min(idleMs, timeoutMs));
        t.unref?.();
      });
    }
    return new Promise((resolve) => {
      let idleTimer = null;
      const done = () => {
        clearTimeout(mainTimer);
        if (idleTimer) clearTimeout(idleTimer);
        sess.waiters.delete(onData);
        resolve(drainSession(sess));
      };
      const onData = () => {
        if (sess.closed) return done();
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(done, idleMs);
        idleTimer.unref?.();
      };
      sess.waiters.add(onData);
      const mainTimer = setTimeout(done, Math.max(0, timeoutMs));
      mainTimer.unref?.();
    });
  }

  async function handleTcpSession(args) {
    const action = args?.action;
    if (!['connect', 'send', 'recv', 'close', 'list'].includes(action)) {
      throw mcpError('bad_request', 'action must be connect, send, recv, close, or list');
    }

    if (action === 'list') {
      const now = Date.now();
      return [...tcpSessions.values()].map((s) => ({
        sid: s.sid,
        host: s.host,
        port: s.port,
        challengeId: s.challengeId,
        bufferedBytes: s.bufferedBytes,
        ageSec: Math.floor((now - s.lastActiveAt) / 1000)
      }));
    }

    if (action === 'connect') {
      const host = String(args.host ?? '').trim();
      const port = Number(args.port);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw mcpError('bad_request', 'connect requires valid host and port (1..65535)');
      }
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(50, Math.min(args.timeoutMs, 30000)) : 5000;
      const challengeId = validateChallengeId(args.challengeId);
      const sid = newId('tcp');
      const socket = net.createConnection({ host, port });
      const now = Date.now();
      const sess = {
        sid,
        socket,
        host,
        port,
        challengeId,
        chunks: [],
        bufferedBytes: 0,
        overflowed: false,
        lastActiveAt: now,
        closed: false,
        error: null,
        waiters: new Set()
      };
      socket.on('data', (chunk) => {
        sess.lastActiveAt = Date.now();
        let c = chunk;
        if (c.length > tcpMaxBufferBytes) {
          c = c.subarray(c.length - tcpMaxBufferBytes);
          sess.chunks = [];
          sess.bufferedBytes = 0;
          sess.overflowed = true;
        }
        sess.chunks.push(c);
        sess.bufferedBytes += c.length;
        while (sess.bufferedBytes > tcpMaxBufferBytes && sess.chunks.length > 0) {
          const dropped = sess.chunks.shift();
          sess.bufferedBytes -= dropped.length;
          sess.overflowed = true;
        }
        for (const fn of sess.waiters) fn();
      });
      socket.on('error', (err) => {
        sess.error = err.message;
        sess.closed = true;
        for (const fn of sess.waiters) fn();
      });
      socket.on('close', () => {
        sess.closed = true;
        for (const fn of sess.waiters) fn();
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(mcpError('tcp_timeout', `TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (e) => { clearTimeout(timer); reject(mcpError('tcp_error', `TCP connect failed: ${e.message}`)); });
      });

      if (tcpSessions.size >= tcpMaxSessions) {
        let oldest = null;
        for (const s of tcpSessions.values()) {
          if (!oldest || s.lastActiveAt < oldest.lastActiveAt) oldest = s;
        }
        if (oldest) {
          try { oldest.socket.destroy(); } catch { /* ignore */ }
          oldest.closed = true;
          tcpSessions.delete(oldest.sid);
          await recordEvent(oldest.challengeId, 'mcp.tcp', { action: 'evict', sid: oldest.sid, reason: 'max_sessions' });
        }
      }

      tcpSessions.set(sid, sess);
      const bannerWait = Math.min(timeoutMs, 400);
      const banner = await waitForChunk(sess, bannerWait);
      const out = { sid, host, port, connected: !sess.closed, banner: banner.data, bannerBase64: banner.dataBase64 };
      await recordEvent(sess.challengeId, 'mcp.tcp', { action: 'connect', sid, host, port, bannerBytes: banner.data.length });
      return out;
    }

    const sid = String(args.sid ?? '');
    const sess = tcpSessions.get(sid);
    if (!sess) throw mcpError('tcp_unknown', `unknown tcp session ${sid}`);
    sess.lastActiveAt = Date.now();

    if (action === 'close') {
      const overflowed = Boolean(sess.overflowed);
      sess.socket.destroy();
      sess.closed = true;
      tcpSessions.delete(sid);
      await recordEvent(sess.challengeId, 'mcp.tcp', { action: 'close', sid, ...(overflowed ? { overflowed: true } : {}) });
      return { sid, closed: true, ...(overflowed ? { overflowed: true } : {}) };
    }

    if (action === 'send') {
      if (sess.closed) throw mcpError('tcp_closed', `tcp session ${sid} is closed`);
      const enc = ['utf8', 'base64', 'hex'].includes(args.encoding) ? args.encoding : 'utf8';
      const payload = Buffer.from(String(args.data ?? ''), enc);
      await new Promise((resolve, reject) => {
        sess.socket.write(payload, (err) => (err ? reject(mcpError('tcp_error', err.message)) : resolve()));
      });
      const waitMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.min(args.timeoutMs, 30000)) : 500;
      const reply = waitMs > 0 ? await waitForChunk(sess, waitMs) : drainSession(sess);
      await recordEvent(sess.challengeId, 'mcp.tcp', { action: 'send', sid, sentBytes: payload.length, recvBytes: reply.data.length });
      return { sid, sentBytes: payload.length, data: reply.data, dataBase64: reply.dataBase64, closed: sess.closed, ...(reply.overflowed ? { overflowed: true } : {}) };
    }

    // action === 'recv'
    const waitMs = Number.isFinite(args.timeoutMs) ? Math.max(0, Math.min(args.timeoutMs, 30000)) : 1000;
    const recv = await waitForChunk(sess, waitMs);
    await recordEvent(sess.challengeId, 'mcp.tcp', { action: 'recv', sid, recvBytes: recv.data.length, closed: sess.closed });
    return { sid, data: recv.data, dataBase64: recv.dataBase64, closed: sess.closed, ...(recv.overflowed ? { overflowed: true } : {}) };
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'ingest_challenge': {
        const target = normalizeTarget(args.target);
        let source;
        let value = '';
        if (typeof args.bytes === 'string' && args.bytes.length > 0) {
          source = 'upload';
          value = { data: Buffer.from(args.bytes, 'base64'), filename: args.filename || 'upload.bin' };
        } else if (typeof args.url === 'string' && args.url.trim()) {
          const u = args.url.trim();
          const isArchive = /\.(tar\.gz|tgz|zip)$/i.test(u.split(/[?#]/)[0]);
          source = isArchive ? 'download' : 'url';
          value = u;
        } else if (typeof args.path === 'string' && args.path.trim()) {
          source = 'path';
          value = args.path.trim();
        } else if (target) {
          source = 'none';
        } else {
          throw mcpError('bad_request', 'ingest_challenge requires url, path, bytes, or target');
        }
        const out = await orchestrator.createChallenge({
          source,
          value,
          title: args.title,
          hint: args.hint,
          target,
          flagFormatRegex: args.flagFormatRegex,
          categoryHint: args.categoryHint
        });
        await recordEvent(out.challengeId, 'challenge.ingested', {
          sourceType: source,
          sourceValue: source === 'upload' ? value.filename : value,
          fileCount: out.fileCount,
          topFiles: out.topFiles,
          ...(out.target ? { target: out.target } : {}),
          via: 'mcp'
        });
        return out;
      }

      case 'tcp_session':
        return handleTcpSession(args);

      case 'read_artifact': {
        const { baseDir } = await requireChallenge(args.challengeId);
        if (typeof args.path !== 'string' || !args.path.trim()) {
          throw mcpError('bad_request', 'path must be a non-empty relative path');
        }
        const jail = await makeJail([baseDir]);
        const targetPath = path.resolve(baseDir, args.path);
        const check = await jail.check(targetPath);
        if (!check.ok) throw mcpError('path_jail', `path escapes challenge base: ${args.path}`);
        const st = await fs.stat(check.resolved);
        const offset = Math.max(0, Number(args.offset) || 0);
        const maxBytes = Math.max(1, Math.min(Number(args.maxBytes) || MAX_READ_BYTES, 1024 * 1024));
        if (st.size > maxFileBytes && args.offset === undefined && args.maxBytes === undefined) {
          throw mcpError('file_too_large', `file size ${st.size} exceeds mcp.maxFileBytes (${maxFileBytes})`);
        }
        const toRead = Math.max(0, Math.min(maxBytes, st.size - offset));
        const slice = Buffer.alloc(toRead);
        if (toRead > 0) {
          const fh = await fs.open(check.resolved, 'r');
          try {
            let total = 0;
            while (total < toRead) {
              const { bytesRead } = await fh.read(slice, total, toRead - total, offset + total);
              if (bytesRead === 0) break;
              total += bytesRead;
            }
            if (total < toRead) {
              // File shrank concurrently
              slice.fill(0, total);
            }
          } finally {
            await fh.close();
          }
        }
        const text = isLikelyText(slice);
        const out = {
          challengeId: args.challengeId,
          path: args.path,
          size: st.size,
          offset,
          encoding: text ? 'utf8' : 'base64',
          content: slice.toString(text ? 'utf8' : 'base64'),
          truncated: offset + slice.length < st.size
        };
        await recordEvent(args.challengeId, 'mcp.artifact.read', { path: args.path, size: st.size });
        return out;
      }

      case 'search_artifacts': {
        const { baseDir } = await requireChallenge(args.challengeId);
        if (typeof args.pattern !== 'string' || !args.pattern) {
          throw mcpError('bad_request', 'pattern must be a non-empty string');
        }
        let re;
        try {
          re = new RegExp(args.pattern, 'i');
        } catch (e) {
          throw mcpError('bad_request', `invalid pattern regex: ${e.message}`);
        }
        const maxHits = Math.max(1, Math.min(Number(args.maxHits) || 50, 200));
        const hits = [];

        async function walk(dir) {
          if (hits.length >= maxHits) return;
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (hits.length >= maxHits) break;
            if (e.name === '.git') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              await walk(full);
            } else if (e.isFile()) {
              const st = await fs.stat(full).catch(() => null);
              if (!st || st.size > MAX_SEARCH_FILE_BYTES) continue;
              const buf = await fs.readFile(full).catch(() => null);
              if (!buf || !isLikelyText(buf)) continue;
              const rel = path.relative(baseDir, full).replace(/\\/g, '/');
              const lines = buf.toString('utf8').split(/\r?\n/);
              for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
                if (re.test(lines[i])) {
                  hits.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
                }
              }
            }
          }
        }
        await walk(baseDir);
        await recordEvent(args.challengeId, 'mcp.artifact.search', { pattern: args.pattern, hitCount: hits.length });
        return { challengeId: args.challengeId, pattern: args.pattern, hits };
      }

      case 'submit_flag': {
        const { meta } = await requireChallenge(args.challengeId);
        const flag = String(args.flag ?? '').trim();
        if (!flag) throw mcpError('bad_request', 'flag must be a non-empty string');
        let formatMatch = 'unknown';
        if (meta?.flagFormatRegex) {
          try {
            formatMatch = new RegExp(meta.flagFormatRegex).test(flag) ? 'match' : 'mismatch';
          } catch { formatMatch = 'unknown'; }
        }
        const reasoning = typeof args.reasoning === 'string' ? args.reasoning : '';
        await recordEvent(args.challengeId, 'flag.found', { flag, formatMatch, reasoning, source: 'mcp' });
        return { recorded: true, challengeId: args.challengeId, flag, formatMatch };
      }

      case 'swarm_run': {
        const out = await orchestrator.createSwarm({
          challengeId: args.challengeId,
          workers: args.workers
        });
        await recordEvent(args.challengeId, 'mcp.swarm.run', { swarmId: out.swarmId, workers: args.workers ?? null });
        return { swarmId: out.swarmId, challengeId: args.challengeId };
      }

      case 'swarm_status': {
        const swarmId = String(args.swarmId ?? '');
        if (!swarmId) throw mcpError('bad_request', 'swarmId is required');
        const live = orchestrator.statusSummary(swarmId);
        if (live) {
          await recordEvent(live.challengeId, 'mcp.swarm.status', { swarmId });
          return live;
        }
        const rec = await locateSwarm(challengesDir, swarmId);
        if (!rec) throw mcpError('swarm_unknown', `unknown swarm ${swarmId}`);
        const state = rebuildSwarmState(rec.swarmId, rec.challengeId, await replayFile(rec.storeFile));
        await recordEvent(rec.challengeId, 'mcp.swarm.status', { swarmId });
        return state;
      }

      default:
        throw mcpError('tool_unknown', `Unknown tool: ${name}`);
    }
  }

  async function handleRpc(msg) {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }

    try {
      let result;
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : '2025-06-18';
          result = {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'shingun', version: '1.0.0' }
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: MCP_TOOLS };
          break;
        case 'tools/call': {
          const toolName = params?.name;
          try {
            const data = await callTool(toolName, params?.arguments ?? {});
            result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
          } catch (err) {
            if (err?.code === 'tool_unknown') {
              if (isNotification) return null;
              return { jsonrpc: '2.0', id, error: { code: -32602, message: err.message } };
            }
            result = {
              content: [{ type: 'text', text: err?.message ?? String(err) }],
              isError: true
            };
          }
          break;
        }
        default:
          if (isNotification) return null;
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32603, message: e?.message ?? String(e) } };
    }
  }

  async function handleHttp(req, res) {
    if (req.method === 'DELETE') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
      });
      res.write(': shingun mcp stream\n\n');
      const hb = setInterval(() => {
        if (!res.writableEnded) res.write(': hb\n\n');
      }, 15000);
      hb.unref?.();
      req.on('close', () => {
        clearInterval(hb);
        try { res.end(); } catch { /* closed */ }
      });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: 'use POST, GET, or DELETE on /mcp' } }));
      return;
    }

    const maxMcpBytes = 64 * 1024 * 1024;
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > maxMcpBytes) {
      throw mcpError('payload_too_large', 'MCP request exceeds 64MB');
    }
    const bodyText = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > maxMcpBytes) {
          done = true;
          req.pause();
          reject(mcpError('payload_too_large', 'MCP request exceeds 64MB'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((m) => handleRpc(m)))).filter(Boolean);
      if (!responses.length) {
        res.writeHead(202);
        res.end();
        return;
      }
      const hasInit = payload.some((m, i) => m?.method === 'initialize') && responses.some((r) => r && !r.error);
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (hasInit) headers['Mcp-Session-Id'] = newId('mcp');
      res.writeHead(200, headers);
      res.end(JSON.stringify(responses));
      return;
    }

    const response = await handleRpc(payload);
    if (!response) {
      res.writeHead(202);
      res.end();
      return;
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (payload?.method === 'initialize' && !response.error) {
      headers['Mcp-Session-Id'] = newId('mcp');
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(response));
  }

  /** Run MCP over stdio (newline-delimited JSON-RPC, plus Content-Length fallback). */
  function serveStdio(input = process.stdin, output = process.stdout) {
    let buf = Buffer.alloc(0);
    let queue = Promise.resolve();

    const writeMsg = (obj) => {
      if (obj) output.write(JSON.stringify(obj) + '\n');
    };

    const enqueue = (raw) => {
      queue = queue.then(async () => {
        let msg;
        try { msg = JSON.parse(raw); }
        catch {
          writeMsg({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        if (Array.isArray(msg)) {
          for (const item of msg) writeMsg(await handleRpc(item));
        } else {
          writeMsg(await handleRpc(msg));
        }
      }).catch((e) => {
        process.stderr.write(`shingun-mcp error: ${e.message}\n`);
      });
    };

    input.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const text = buf.toString('utf8');
        if (/^Content-Length:\s*\d+/i.test(text.trimStart())) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const header = buf.subarray(0, headerEnd).toString('utf8');
          const m = /Content-Length:\s*(\d+)/i.exec(header);
          const len = m ? Number(m[1]) : 0;
          const bodyStart = headerEnd + 4;
          if (buf.length < bodyStart + len) break;
          const body = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
          buf = buf.subarray(bodyStart + len);
          enqueue(body);
          continue;
        }
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (line) enqueue(line);
      }
    });

    return new Promise((resolve) => {
      input.on('end', () => queue.finally(() => { closeAll(); resolve(); }));
    });
  }

  function closeAll() {
    clearInterval(tcpReaper);
    for (const sess of tcpSessions.values()) {
      try { sess.socket.destroy(); } catch { /* ignore */ }
    }
    tcpSessions.clear();
  }

  return { handleRpc, handleHttp, serveStdio, callTool, closeAll, tools: MCP_TOOLS };
}
