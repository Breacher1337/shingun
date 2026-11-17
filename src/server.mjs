import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ingestChallenge } from './ingest.mjs';
import { listTree, nowIso, writeJson } from './util.mjs';

/**
 * Localhost HTTP surface: JSON API + SSE event stream + the dashboard's
 * static shell. The server is a thin skin over the in-process engine:
 * it owns no swarm state of its own — swarm reads are reconstructed by
 * replaying the append-only event store, and swarm writes go straight
 * to the orchestrator.
 */

const TERMINAL_STATUSES = ['solved', 'stopped', 'capped'];

function httpError(code, message, detail) {
  const err = Object.assign(new Error(message), { code });
  if (detail !== undefined) err.detail = detail;
  return err;
}

function readJsonBody(req, capBytes = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > capBytes) {
        done = true;
        reject(httpError('payload_too_large', `request body exceeds ${capBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError('bad_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', (e) => {
      if (!done) { done = true; reject(e); }
    });
  });
}

/** Monotonic sequence number from an event id ("<swarmId>-00042"). */
function eventSeq(event) {
  const m = /-(\d+)$/.exec(String(event.id ?? ''));
  return m ? Number(m[1]) : 0;
}

export async function startServer({
  config,
  env,
  orchestrator,
  bus,
  workspaceDir,
  webDir,
  envFile = null
}) {
  const challengesDir = path.join(workspaceDir, 'challenges');
  await fs.mkdir(challengesDir, { recursive: true });

  // Gate credential: from .env, or generated (and persisted) on first serve.
  let token = env?.SHINGUN_TOKEN;
  let tokenGenerated = false;
  if (!token) {
    token = randomBytes(16).toString('hex');
    tokenGenerated = true;
    if (envFile) {
      await fs.appendFile(envFile, `SHINGUN_TOKEN=${token}\n`, 'utf8').catch(() => {});
    }
  }

  const authorize = (req) => {
    const got = req.headers.authorization ?? '';
    return got === `Bearer ${token}`;
  };

  // -- filesystem helpers ------------------------------------------------

  /** Locate an event store by swarm id, ignoring any in-memory index. */
  async function locateSwarm(swarmId) {
    if (!/^[\w-]+$/.test(swarmId)) return null;
    const entries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const storeFile = path.join(challengesDir, entry.name, 'events', `${swarmId}.jsonl`);
      const exists = await fs.stat(storeFile).then(() => true).catch(() => false);
      if (exists) {
        return {
          swarmId,
          challengeId: entry.name,
          chDir: path.join(challengesDir, entry.name),
          storeFile
        };
      }
    }
    return null;
  }

  async function replay(file) {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt tail line */ }
    }
    return out;
  }

  /** Reconstruct the full swarm state by replaying its event store. */
  function rebuildSwarmState(swarmId, challengeId, events) {
    const workers = new Map();
    const worker = (id) => {
      if (!workers.has(id)) {
        workers.set(id, {
          id,
          persona: '(unknown)',
          status: 'spawning',
          steps: 0,
          tokensIn: 0,
          tokensOut: 0,
          seenAt: null,
          diff: null,
          tools: [],
          logs: [],
          flags: [],
          stallChecks: 0
        });
      }
      return workers.get(id);
    };
    const state = {
      swarmId,
      challengeId,
      status: 'planning',
      final: false,
      startedAt: events[0]?.t ?? nowIso(),
      updatedAt: events[events.length - 1]?.t ?? nowIso(),
      challenge: { sourceType: null, sourceValue: null, category: null, flagFormat: null },
      triage: null,
      flags: [],
      budget: { usd: 0, tokensIn: 0, tokensOut: 0 },
      masterChat: [],
      admission: null,
      postmortem: null,
      capNote: null
    };
    let lastSeq = 0;
    for (const ev of events) {
      lastSeq = Math.max(lastSeq, eventSeq(ev));
      const w = ev.worker ? worker(ev.worker) : null;
      switch (ev.type) {
        case 'challenge.ingested':
          state.challenge.sourceType = ev.data.sourceType ?? null;
          state.challenge.sourceValue = ev.data.sourceValue ?? null;
          break;
        case 'master.triage':
          state.triage = ev.data;
          state.challenge.category = ev.data.category ?? state.challenge.category;
          state.challenge.flagFormat = ev.data.flagFormat?.regex ?? null;
          break;
        case 'worker.spawn':
          if (w) { w.persona = ev.data.persona ?? w.persona; w.spawnedAt = ev.t; }
          break;
        case 'worker.status':
          if (w) w.status = ev.data.status;
          break;
        case 'worker.progress':
          if (w) {
            w.steps = ev.data.steps ?? w.steps;
            w.tokensIn = ev.data.tokensIn ?? w.tokensIn;
            w.tokensOut = ev.data.tokensOut ?? w.tokensOut;
            w.seenAt = ev.t;
          }
          break;
        case 'worker.stalled':
          if (w) w.stallChecks = ev.data.checks ?? w.stallChecks + 1;
          break;
        case 'worker.tool':
          if (w) w.tools.push(ev.data);
          break;
        case 'worker.log':
          if (w) w.logs.push({ seq: ev.data.seq ?? 0, stream: ev.data.stream ?? 'transcript', text: ev.data.text ?? '' });
          break;
        case 'worker.diff':
          if (w) w.diff = ev.data.stats ?? null;
          break;
        case 'flag.found':
          state.flags.push({ workerId: ev.worker, ...ev.data });
          if (w && !w.flags.includes(ev.data.flag)) w.flags.push(ev.data.flag);
          break;
        case 'usage.tick':
          state.budget.usd += Number(ev.data.costUsd ?? 0) || 0;
          state.budget.tokensIn += Number(ev.data.tokensIn ?? 0) || 0;
          state.budget.tokensOut += Number(ev.data.tokensOut ?? 0) || 0;
          break;
        case 'budget.capped':
          state.capNote = ev.data;
          break;
        case 'master.chat':
          state.masterChat.push({ direction: ev.data.direction ?? 'user', text: ev.data.text ?? '', actions: ev.data.actions ?? [], t: ev.t });
          break;
        case 'swarm.update':
          state.status = ev.data.status ?? state.status;
          if (ev.data.final) state.final = true;
          break;
        case 'swarm.stop':
          state.stoppedBy = ev.data.by ?? null;
          break;
        case 'admission.blocked':
          state.admission = ev.data;
          break;
        case 'swarm.postmortem':
          state.postmortem = ev.data.path ?? null;
          break;
        default:
          break;
      }
    }
    for (const w of workers.values()) {
      // Keep the replay payload bounded for live dashboards.
      if (w.logs.length > 240) w.logs = w.logs.slice(-240);
      if (w.tools.length > 240) w.tools = w.tools.slice(-240);
    }
    state.eventCount = events.length;
    state.lastSeq = lastSeq;
    state.workers = [...workers.values()];
    state.caps = {
      perSwarmUsd: config.budget.perSwarmUsd,
      perChallengeUsd: config.budget.perChallengeUsd,
      workerMaxTokens: config.worker.maxTokens,
      workerMaxSteps: config.worker.maxSteps,
      workerWallClockMin: config.worker.wallClockMin
    };
    state.workerIds = [...workers.keys()];
    return state;
  }

  // -- static assets -----------------------------------------------------

  const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/dashboard.mjs': { file: 'dashboard.mjs', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' }
  };

  async function serveStatic(res, entry) {
    const body = await fs.readFile(path.join(webDir, entry.file)).catch(() => null);
    if (body === null) throw httpError('asset_missing', `dashboard asset missing: ${entry.file}`);
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // A bare 401 that doubles as the operator's entry point: browsers cannot
  // attach Authorization headers to address-bar navigations, so the page
  // offers the tokenized URL form. No engine data lives in this response.
  function gatePage(res) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>shingun</title>
<style>body{background:#0b0d10;color:#d7e0e8;font:14px/1.5 ui-monospace,Consolas,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#11151a;border:1px solid #1d232b;padding:24px;border-radius:8px;width:340px}
h1{font-size:15px;margin:0 0 6px;letter-spacing:.08em}.hint{color:#7d8a96;margin:0 0 14px;font-size:12px}
input{width:100%;box-sizing:border-box;background:#0b0d10;color:#d7e0e8;border:1px solid #1d232b;border-radius:4px;padding:8px;font:inherit}
button{margin-top:10px;width:100%;padding:8px;border:0;border-radius:4px;background:#2b6cb0;color:#fff;font:inherit;cursor:pointer}
</style></head><body><form onsubmit="location='/?token='+encodeURIComponent(document.getElementById('t').value);return false">
<h1>shingun</h1><p class="hint">This dashboard requires its bearer token. Open the URL printed by <code>shingun serve</code>, or paste the token:</p>
<input id="t" placeholder="SHINGUN_TOKEN" autofocus><button type="submit">open dashboard</button></form></body></html>`);
  }

  // -- SSE ---------------------------------------------------------------

  async function handleEvents(req, res, swarmId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    const send = (ev) => {
      if (res.writableEnded) return false;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      return true;
    };
    res.write(': shingun event stream\n\n');

    // Subscribe before replaying the backlog so nothing emitted in between
    // is lost; buffer live events until the backlog is written, then drop
    // buffered events the backlog already covered (same event id).
    const pending = [];
    let flushing = false;
    let maxSeqReplayed = 0;
    const unsubscribe = bus.subscribe((ev) => {
      if (swarmId && ev.swarm !== swarmId) return;
      if (!flushing) pending.push(ev);
      else send(ev);
    });

    if (swarmId) {
      const rec = await locateSwarm(swarmId);
      if (rec) {
        for (const ev of await replay(rec.storeFile)) {
          if (eventSeq(ev) > maxSeqReplayed) maxSeqReplayed = eventSeq(ev);
          send(ev);
        }
      }
    }
    flushing = true;
    for (const ev of pending) {
      if (eventSeq(ev) <= maxSeqReplayed) continue; // already streamed from the store
      send(ev);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': hb\n\n');
    }, 15000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch { /* already closed */ }
    });
  }

  // -- request handler ---------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    const pathname = url.pathname;

    // Static shell accepts the token in the query as well: an address-bar
    // navigation cannot carry headers. Data routes below never do.
    const queryToken = url.searchParams.get('token');
    const staticEntry = STATIC_FILES[pathname];
    if (staticEntry) {
      if (authorize(req) || (queryToken && queryToken === token)) return serveStatic(res, staticEntry);
      return gatePage(res);
    }

    if (!authorize(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      return handleEvents(req, res, url.searchParams.get('swarm') ?? null);
    }

    if (!pathname.startsWith('/api/')) {
      throw httpError('not_found', `no route for ${req.method} ${pathname}`);
    }

    const segments = pathname.slice('/api/'.length).split('/').map(decodeURIComponent);

    if (req.method === 'POST' && segments.length === 1 && segments[0] === 'challenges') {
      const body = await readJsonBody(req);
      if (body.source !== 'url' && body.source !== 'path') {
        throw httpError('bad_request', 'source must be "url" or "path"');
      }
      if (typeof body.value !== 'string' || !body.value.trim()) {
        throw httpError('bad_request', 'value must be a non-empty string');
      }
      await fs.mkdir(challengesDir, { recursive: true });
      const ing = await ingestChallenge({ source: body.source, value: body.value.trim(), challengesDir });
      const chDir = path.join(challengesDir, ing.challengeId);
      await writeJson(path.join(chDir, 'challenge.json'), {
        challengeId: ing.challengeId,
        sourceType: body.source,
        sourceValue: body.value.trim(),
        flagFormatRegex: typeof body.flagFormatRegex === 'string' ? body.flagFormatRegex : null,
        categoryHint: typeof body.categoryHint === 'string' ? body.categoryHint : null,
        ingestedAt: nowIso(),
        fileCount: ing.fileCount,
        topFiles: ing.topFiles
      });
      return sendJson(res, 200, { challengeId: ing.challengeId, fileCount: ing.fileCount, topFiles: ing.topFiles });
    }

    if (req.method === 'POST' && segments.length === 3 && segments[0] === 'challenges' && segments[2] === 'swarm') {
      const challengeId = segments[1];
      const body = await readJsonBody(req);
      const chDir = path.join(challengesDir, challengeId);
      const metaFile = path.join(chDir, 'challenge.json');
      const meta = await fs.readFile(metaFile, 'utf8')
        .then((t) => JSON.parse(t))
        .catch(() => null);
      if (!meta) throw httpError('challenge_unknown', `challenge not registered under this server: ${challengeId}`);
      const { fileCount, topFiles } = await listTree(path.join(chDir, 'base')).catch(() => ({ fileCount: 0, topFiles: [] }));
      let workers;
      if (body.workers !== undefined) {
        workers = Number(body.workers);
        if (!Number.isInteger(workers) || workers < 1) {
          throw httpError('bad_request', 'workers must be a positive integer');
        }
        workers = Math.min(workers, config.concurrency.perChallengeWorkers);
      }
      let budgetUsd;
      if (body.budgetUsd !== undefined) {
        budgetUsd = Number(body.budgetUsd);
        if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
          throw httpError('bad_request', 'budgetUsd must be a positive number');
        }
        budgetUsd = Math.min(budgetUsd, config.budget.perSwarmUsd);
      }
      const { swarmId } = await orchestrator.startSwarm({
        challenge: {
          id: challengeId,
          sourceType: meta.sourceType,
          sourceValue: meta.sourceValue,
          baseDir: path.join(chDir, 'base'),
          fileCount,
          topFiles,
          flagFormatRegex: meta.flagFormatRegex,
          categoryHint: meta.categoryHint
        },
        opts: { workers, budgetUsd }
      });
      return sendJson(res, 200, { swarmId });
    }

    if (segments[0] === 'swarms') {
      const swarmId = segments[1];
      if (!swarmId) throw httpError('not_found', `no route for ${req.method} ${pathname}`);

      if (req.method === 'GET' && segments.length === 2) {
        const rec = await locateSwarm(swarmId);
        if (!rec) throw httpError('swarm_unknown', `unknown swarm ${swarmId}`);
        const state = rebuildSwarmState(rec.swarmId, rec.challengeId, await replay(rec.storeFile));
        return sendJson(res, 200, state);
      }

      if (req.method === 'POST' && segments.length === 3 && segments[2] === 'stop') {
        const live = orchestrator.swarms.get(swarmId);
        if (!live) {
          const rec = await locateSwarm(swarmId);
          if (!rec) throw httpError('swarm_unknown', `unknown swarm ${swarmId}`);
          const state = rebuildSwarmState(rec.swarmId, rec.challengeId, await replay(rec.storeFile));
          if (state.final || TERMINAL_STATUSES.includes(state.status)) {
            return sendJson(res, 200, { stopped: true, already: 'terminal' });
          }
          throw httpError('swarm_unknown', `swarm ${swarmId} is not live in this server process`);
        }
        if (TERMINAL_STATUSES.includes(live.status)) {
          return sendJson(res, 200, { stopped: true, already: 'terminal' });
        }
        await orchestrator.stop(swarmId, 'user');
        return sendJson(res, 200, { stopped: true });
      }

      if (req.method === 'POST' && segments.length === 5 && segments[2] === 'workers' && segments[4] === 'message') {
        const body = await readJsonBody(req);
        if (typeof body.text !== 'string' || !body.text.trim()) {
          throw httpError('bad_request', 'text must be a non-empty string');
        }
        const out = await orchestrator.steerWorker(swarmId, segments[3], body.text);
        return sendJson(res, 200, out);
      }

      if (req.method === 'GET' && segments.length === 5 && segments[2] === 'workers' && segments[4] === 'diff') {
        const rec = await locateSwarm(swarmId);
        if (!rec) throw httpError('swarm_unknown', `unknown swarm ${swarmId}`);
        const events = await replay(rec.storeFile);
        const lastDiff = [...events].reverse().find((e) => e.type === 'worker.diff' && e.worker === segments[3]);
        const diffText = await fs.readFile(path.join(rec.chDir, 'diffs', `${segments[3]}.diff`), 'utf8').catch(() => null);
        if (diffText === null && !lastDiff) {
          throw httpError('worker_unknown', `no captured diff for worker ${segments[3]}`);
        }
        return sendJson(res, 200, {
          stats: lastDiff?.data?.stats ?? null,
          diff: diffText,
          capturedAt: lastDiff?.data?.capturedAt ?? null
        });
      }

      throw httpError('not_found', `no route for ${req.method} ${pathname}`);
    }

    if (req.method === 'POST' && segments.length === 2 && segments[0] === 'master' && segments[1] === 'message') {
      const body = await readJsonBody(req);
      if (typeof body.swarm !== 'string' || !body.swarm) {
        throw httpError('bad_request', 'swarm must identify the target swarm id');
      }
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw httpError('bad_request', 'text must be a non-empty string');
      }
      await orchestrator.directive(body.swarm, body.text);
      // The reply travels as master.chat events on /api/events, never here.
      return sendJson(res, 200, { ok: true });
    }

    throw httpError('not_found', `no route for ${req.method} ${pathname}`);
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  const requestHandler = (req, res) => handle(req, res).catch((e) => {
    const code = e?.code ?? 'internal';
    if (!res.headersSent) {
      const status = ['swarm_unknown', 'challenge_unknown', 'worker_unknown', 'not_found'].includes(code) ? 404
        : ['bad_json', 'bad_request', 'payload_too_large'].includes(code) ? 400
        : code === 'unauthorized' ? 401
        : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code, message: e?.message ?? String(e) } }));
    } else {
      res.end();
    }
  });
  const server = http.createServer(requestHandler);

  const listen = (portOverride) => new Promise((resolve, reject) => {
    if (portOverride !== undefined && portOverride !== null) config.port = portOverride;
    // Localhost only: the dashboard and API are never exposed outward.
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      config.port = server.address().port; // report the real bound port (0 = ephemeral)
      resolve();
    });
  });

  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    // SSE connections never end on their own; drop them so close settles.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });

  return {
    server,
    token,
    tokenGenerated,
    get url() { return `http://127.0.0.1:${config.port}/`; },
    get dashboardUrl() { return `http://127.0.0.1:${config.port}/?token=${token}`; },
    listen,
    close
  };
}
