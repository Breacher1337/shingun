import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ingestChallenge } from './ingest.mjs';
import { buildBundle } from './bundle.mjs';
import { createGuardLedger } from './ledger.mjs';
import { preflightRoleProviders } from './providers/preflight.mjs';
import { resolveApiKey } from './providers/registry.mjs';
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
  envFile = null,
  configFile = null
}) {
  const challengesDir = path.join(workspaceDir, 'challenges');
  await fs.mkdir(challengesDir, { recursive: true });

  // Cockpit guard ledger: proposed-but-unconfirmed actions live here, in
  // memory only — a restart clears the queue, exactly like a human would
  // forget an un-confirmed instruction. Terminal swarms retire their
  // pending actions so a confirm never lands on a dead swarm.
  const guardLedger = createGuardLedger({ config });
  const idempotencyCache = new Map();
  const executedActions = new Map();
  bus.subscribe((ev) => {
    if (ev?.type === 'swarm.update' && ev?.swarm && ev?.data?.final) {
      guardLedger.expireSwarm(ev.swarm);
    }
  });

  /** Upsert NAME=value in a .env-style file. False only when the write fails. */
  async function upsertEnvValue(file, name, value) {
    try {
      let text = '';
      try { text = await fs.readFile(file, 'utf8'); } catch { /* absent is fine */ }
      const re = new RegExp(`^\\s*${name}=.*$`, 'm');
      const out = re.test(text)
        ? text.replace(re, `${name}=${value}`)
        : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${name}=${value}\n`;
      await fs.writeFile(file, out, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply `mutate` to the parsed operator config and write it back.
   * False on any read/write failure (config stays operator-owned).
   */
  async function persistConfigMutation(file, mutate) {
    try {
      const cur = await fs.readFile(file, 'utf8')
        .then((t) => JSON.parse(t))
        .catch(() => ({}));
      mutate(cur);
      await writeJson(file, cur);
      return true;
    } catch {
      return false;
    }
  }

  // Access is OPEN by default: a localhost workspace for one operator should
  // not carry a bearer gate. Setting SHINGUN_TOKEN in .env opts back into
  // gating (header or ?token= on the shell); nothing is ever auto-generated.
  const token = env?.SHINGUN_TOKEN || null;
  const gated = Boolean(token);

  const authorize = (req) => {
    if (!gated) return true;
    const got = req.headers.authorization ?? '';
    return got === `Bearer ${token}`;
  };

  // DNS-rebinding guard: the browser (or any client) must address this
  // service by its loopback name, never through a foreign hostname that
  // happens to resolve to 127.0.0.1.
  const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const loopbackNamed = (req) => {
    const host = String(req.headers.host ?? '');
    const name = host.replace(/:\d+$/, '').toLowerCase();
    return LOCAL_HOSTNAMES.has(name);
  };

  // -- launch preflight ----------------------------------------------------

  // One implementation lives in src/providers/preflight.mjs and is shared
  // with the console create_swarm tool, so the launch route and the master
  // agent refuse with the same message for the same broken config.

  function preflightIssues() {
    return preflightRoleProviders(config, env);
  }

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
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/tokens.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
    '/theme-preview.html': { file: 'theme-preview.html', type: 'text/html; charset=utf-8' }
  };

  async function serveStatic(res, entry) {
    const body = await fs.readFile(path.join(webDir, entry.file)).catch(() => null);
    if (body === null) throw httpError('asset_missing', `dashboard asset missing: ${entry.file}`);
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // A bare 401 that doubles as the operator's entry point: browsers cannot
  // attach Authorization headers to address-bar navigations, so the page
  // offers the tokenized URL form. Validation round-trips through an
  // authorized static request, and a wrong token gets explicit feedback —
  // no engine data lives in this response.
  function gatePage(res) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>shingun</title>
<style>body{background:#0b0d10;color:#d7e0e8;font:14px/1.5 ui-monospace,Consolas,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#11151a;border:1px solid #1d232b;padding:24px;border-radius:8px;width:380px}
h1{font-size:15px;margin:0 0 6px;letter-spacing:.08em}.hint{color:#7d8a96;margin:0 0 10px;font-size:12px}
.notkey{color:#ffb454;font-size:11px;margin:0 0 14px;padding:6px 8px;border:1px solid #6b4a26;border-radius:4px;background:rgba(107,74,38,.12)}
label{display:block;font-size:11px;color:#7d8a96;margin-top:14px}
input{width:100%;box-sizing:border-box;background:#0b0d10;color:#d7e0e8;border:1px solid #1d232b;border-radius:4px;padding:8px;font:inherit;margin-top:4px}
button{width:100%;margin-top:14px;padding:8px;border:0;border-radius:4px;background:#2b6cb0;color:#fff;font:inherit;cursor:pointer}
button:disabled{background:#161b21;color:#4a5560;cursor:wait}
.error{color:#ff8c42;font-size:12px;margin-top:10px;min-height:16px}
</style></head><body><form id="gt-form" onsubmit="return false">
<h1>shingun</h1>
<p class="hint">This page needs the dashboard <b>access token</b> — not a model provider API key.</p>
<p class="notkey">Paste the token from the <code>dashboard:</code> URL that <code>shingun serve</code> prints (also in the repo\u2019s <code>.env</code> as <code>SHINGUN_TOKEN</code>).</p>
<label for="t">access token</label>
<input id="t" placeholder="SHINGUN_TOKEN" autocomplete="off" autofocus>
<div class="error" id="e"></div>
<button id="gt-button" type="button" onclick="(function(){var b=document.getElementById('gt-button');b.disabled=true;var e=document.getElementById('e');e.textContent='';fetch('/style.css',{headers:{Authorization:'Bearer '+document.getElementById('t').value.trim()}}).then(function(r){b.disabled=false;if(r.ok){localStorage.setItem('shingun.token',document.getElementById('t').value.trim());location=location.pathname;}else{e.textContent='token rejected — check SHINGUN_TOKEN in .env';}}).catch(function(){b.disabled=false;e.textContent='could not reach the server — is shingun serve running?';});})()">open dashboard</button></form></body></html>`);
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
      // A scoped stream carries its swarm; an unscoped stream carries the
      // console thread only (its ids are console-<seq>, so they never
      // collide with a swarm's sequence).
      if (swarmId && ev.swarm !== swarmId) return;
      if (!swarmId && ev.swarm != null) return;
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
    } else {
      // Console backlog: the persisted thread replays as stored bytes.
      for (const ev of await orchestrator.getConsoleStore().replay()) {
        if (eventSeq(ev) > maxSeqReplayed) maxSeqReplayed = eventSeq(ev);
        send(ev);
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
    // Rebinding guard first: foreign hostnames never reach a route.
    if (!loopbackNamed(req)) {
      sendJson(res, 403, { error: { code: 'host_forbidden', message: 'this service answers only to its loopback name' } });
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    const pathname = url.pathname;

    // Static shell accepts the token in the query as well: an address-bar
    // navigation cannot carry headers. Data routes below never do. Without
    // a configured token the workspace is simply open.
    const queryToken = url.searchParams.get('token');
    const staticEntry = STATIC_FILES[pathname];
    if (staticEntry) {
      if (authorize(req) || (gated && queryToken && queryToken === token)) return serveStatic(res, staticEntry);
      return gatePage(res);
    }

    if (!authorize(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } }));
      return;
    }

    if (pathname === '/api/events' || pathname === '/api/v1/events') {
      if (req.method !== 'GET') throw httpError('not_found', `no route for ${req.method} ${pathname}`);
      return handleEvents(req, res, url.searchParams.get('swarm') ?? null);
    }

    if (!pathname.startsWith('/api/')) {
      throw httpError('not_found', `no route for ${req.method} ${pathname}`);
    }

    let subpath = pathname.slice('/api/'.length);
    if (subpath.startsWith('v1/')) {
      subpath = subpath.slice('v1/'.length);
    } else if (subpath === 'v1') {
      subpath = '';
    }
    const segments = subpath ? subpath.split('/').map(decodeURIComponent) : [];

    // Operator key provisioning: scan providers for missing keys; a POST/PUT
    // supplies one without a restart. Key values never appear in responses.
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'providers') {
      const providers = {};
      for (const [name, prov] of Object.entries(config.providers ?? {})) {
        providers[name] = {
          type: prov.type ?? null,
          baseUrl: prov.type === 'openai-compat' ? (prov.baseUrl ?? null) : null,
          defaultModel: prov.defaultModel ?? null,
          // Entries without their own var share the universal OPENAI_API_KEY.
          apiKeyEnv: prov.type === 'openai-compat' ? (prov.apiKeyEnv ?? 'OPENAI_API_KEY') : null,
          // null → keyless by design (mock); boolean → key present or not
          hasKey: prov.type === 'openai-compat'
            ? Boolean(resolveApiKey(prov, env))
            : null
        };
      }
      return sendJson(res, 200, { providers, roles: config.roles ?? {} });
    }

    const isProviderKeyPut = (req.method === 'PUT' || req.method === 'POST') && segments.length === 3 && segments[0] === 'providers' && segments[2] === 'key';
    const isLegacyProviderKeyPost = req.method === 'POST' && segments.length === 1 && segments[0] === 'provider-key';
    if (isProviderKeyPut || isLegacyProviderKeyPost) {
      const body = await readJsonBody(req);
      const name = isProviderKeyPut ? segments[1] : (typeof body.provider === 'string' ? body.provider : '');
      const prov = config.providers?.[name];
      if (!prov) throw httpError('bad_request', `unknown provider "${name}"`);
      if (prov.type !== 'openai-compat') {
        throw httpError('bad_request', `provider "${name}" takes no API key`);
      }
      // Entries with their own var keep it; the rest live on the universal
      // OPENAI_API_KEY so switching endpoint stays a config change.
      const keyVar = prov.apiKeyEnv ?? 'OPENAI_API_KEY';
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (key.length < 8 || /\s/.test(key)) {
        throw httpError('bad_request', 'apiKey must be at least 8 characters with no whitespace');
      }
      if (/:\/\//.test(key)) {
        throw httpError('bad_request', 'apiKey looks like a web address — that is the dashboard URL, not a model provider key. Paste the API key issued by the provider console (for mistral: console.mistral.ai → API keys).');
      }
      // Live: the env object is shared with the orchestrator and providers
      // are built per spawn, so the key applies without a restart.
      env[keyVar] = key;
      // Durable: upsert into the operator .env so restarts keep the key.
      const persisted = envFile ? await upsertEnvValue(envFile, keyVar, key) : false;
      // Optional activation: swap the master/worker role providers live and
      // persist the roles to the operator config.
      let activated = false;
      let rolesPersisted = envFile ? true : false;
      if (body.activate === true) {
        const setProvider = (roles) => {
          for (const roleName of ['master', 'worker']) {
            const cur = roles[roleName];
            roles[roleName] = { ...(cur && typeof cur === 'object' ? cur : {}), provider: name };
          }
        };
        config.roles ?? (config.roles = {});
        setProvider(config.roles);
        activated = true;
        if (configFile) rolesPersisted = await persistConfigMutation(configFile, setProvider);
      }
      return sendJson(res, 200, { ok: true, provider: name, hasKey: true, activated, persisted, rolesPersisted });
    }

    // Role switching: point master/worker at any configured provider,
    // including the keyless mock — the escape hatch when no key is around.
    if ((req.method === 'PUT' || req.method === 'POST') && segments.length === 1 && segments[0] === 'roles') {
      const body = await readJsonBody(req);
      const wanted = {};
      if (typeof body.both === 'string') { wanted.master = body.both; wanted.worker = body.both; }
      if (typeof body.master === 'string') wanted.master = body.master;
      if (typeof body.worker === 'string') wanted.worker = body.worker;
      const names = Object.values(wanted);
      if (!names.length) throw httpError('bad_request', 'body must name master, worker, or both');
      for (const n of names) {
        if (!config.providers?.[n]) throw httpError('bad_request', `unknown provider "${n}"`);
      }
      config.roles ?? (config.roles = {});
      for (const [roleName, provName] of Object.entries(wanted)) {
        const cur = config.roles[roleName];
        config.roles[roleName] = { ...(cur && typeof cur === 'object' ? cur : {}), provider: provName };
      }
      const persisted = configFile
        ? await persistConfigMutation(configFile, (f) => {
            f.roles ?? (f.roles = {});
            for (const [roleName, provName] of Object.entries(wanted)) {
              f.roles[roleName] = { ...(f.roles[roleName] && typeof f.roles[roleName] === 'object' ? f.roles[roleName] : {}), provider: provName };
            }
          })
        : false;
      return sendJson(res, 200, { ok: true, roles: config.roles, persisted, issues: preflightIssues() });
    }

    if (req.method === 'POST' && segments.length === 1 && segments[0] === 'challenges') {
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && idempotencyCache.has(idemKey)) {
        const cached = idempotencyCache.get(idemKey);
        return sendJson(res, cached.status, cached.body, cached.headers);
      }
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
      const resBody = { challengeId: ing.challengeId, fileCount: ing.fileCount, topFiles: ing.topFiles };
      const resHeaders = { Location: `/api/v1/challenges/${ing.challengeId}` };
      if (idemKey) {
        idempotencyCache.set(idemKey, { status: 201, body: resBody, headers: resHeaders });
      }
      return sendJson(res, 201, resBody, resHeaders);
    }

    if (req.method === 'GET' && segments.length === 2 && segments[0] === 'challenges') {
      const challengeId = segments[1];
      const metaFile = path.join(challengesDir, challengeId, 'challenge.json');
      const meta = await fs.readFile(metaFile, 'utf8')
        .then((t) => JSON.parse(t))
        .catch(() => null);
      if (!meta) throw httpError('challenge_unknown', `unknown challenge ${challengeId}`);
      return sendJson(res, 200, meta);
    }

    if (req.method === 'POST' && segments.length === 3 && segments[0] === 'challenges' && (segments[2] === 'swarms' || segments[2] === 'swarm')) {
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && idempotencyCache.has(idemKey)) {
        const cached = idempotencyCache.get(idemKey);
        return sendJson(res, cached.status, cached.body, cached.headers);
      }
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
      const providerIssue = preflightIssues();
      if (providerIssue) throw httpError(providerIssue.code, providerIssue.message);
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
      const resBody = { swarmId };
      const resHeaders = { Location: `/api/v1/swarms/${swarmId}` };
      if (idemKey) {
        idempotencyCache.set(idemKey, { status: 201, body: resBody, headers: resHeaders });
      }
      return sendJson(res, 201, resBody, resHeaders);
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

      const isDeleteStop = req.method === 'DELETE' && segments.length === 2;
      const isPostStop = req.method === 'POST' && segments.length === 3 && segments[2] === 'stop';
      if (isDeleteStop || isPostStop) {
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

      // Review bundle download: terminal swarms only (the bundle builder
      // enforces the same, this is just HTTP-shaped error reporting).
      if (req.method === 'GET' && segments.length === 3 && segments[2] === 'bundle') {
        const out = await buildBundle({ swarmId, workspaceDir, bus });
        const bytes = await fs.readFile(out.path).catch(() => null);
        if (bytes === null) throw httpError('internal', 'bundle built but unreadable');
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="shingun-${swarmId}.tar.gz"`,
          'Cache-Control': 'no-store'
        });
        res.end(bytes);
        return;
      }

      if (req.method === 'POST' && segments.length === 5 && segments[2] === 'workers' && (segments[4] === 'messages' || segments[4] === 'message')) {
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

    // -- cockpit: the prompt is the master panel --------------------------

    // POST /api/v1/master/messages (and legacy POST /api/master/message) {swarm?, text, guard?}
    // Absent swarm = console scope: the master plans over the whole
    // workspace (create challenges, launch swarms, purge, remove) instead
    // of steering one live swarm.
    if (req.method === 'POST' && segments.length === 2 && segments[0] === 'master' && (segments[1] === 'messages' || segments[1] === 'message')) {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw httpError('bad_request', 'text must be a non-empty string');
      }
      if (body.swarmId !== undefined) {
        throw httpError('bad_request', 'pass "swarm", not "swarmId"');
      }
      const mode = guardLedger.validateMode(body.guard);
      const gate = (a) => guardLedger.gate({ ...a, mode });
      const hasSwarm = typeof body.swarm === 'string' && body.swarm.length > 0;
      if (hasSwarm) {
        guardLedger.expireForDirective({ scope: 'sw', swarm: body.swarm });
        await orchestrator.directive(body.swarm, body.text, { gate });
      } else if (body.swarm === undefined || body.swarm === null || body.swarm === '') {
        guardLedger.expireForDirective({ scope: 'console' });
        await orchestrator.directiveConsole({ text: body.text, gate });
      } else {
        throw httpError('bad_request', 'swarm must be a swarm id string or absent for console scope');
      }
      // The reply travels as master.chat events on /api/events, never here.
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/v1/master/confirm (and legacy POST /api/master/confirm, or /api/v1/actions/:actionId/confirm) {actionId}
    // executes exactly one ledger entry. Superseded answers 410; unknown answers 404.
    // Repeating an already-executed action returns the cached receipt { executed: true, actionId }.
    const isMasterConfirm = req.method === 'POST' && segments.length === 2 && segments[0] === 'master' && segments[1] === 'confirm';
    const isActionConfirm = req.method === 'POST' && segments.length === 3 && segments[0] === 'actions' && segments[2] === 'confirm';
    if (isMasterConfirm || isActionConfirm) {
      let actionId;
      if (isActionConfirm) {
        actionId = segments[1]?.trim();
      } else {
        const body = await readJsonBody(req);
        if (typeof body.actionId !== 'string' || !body.actionId.trim()) {
          throw httpError('bad_request', 'actionId must be a non-empty string');
        }
        actionId = body.actionId.trim();
      }
      if (executedActions.has(actionId)) {
        return sendJson(res, 200, executedActions.get(actionId));
      }
      const { action, entry } = await guardLedger.confirm(actionId);
      await orchestrator.recordExecuted({ entry, action });
      const receipt = { executed: true, actionId };
      executedActions.set(actionId, receipt);
      return sendJson(res, 200, receipt);
    }

    // GET /api/v1/node & GET /api/node — node-scope read-back for the operator: console thread
    // tail, the pending confirm ledger with actionIds, the current guard
    // mode, and a compact summary of every known swarm. A read: it is never
    // gated, in any guard mode.
    if (req.method === 'GET' && segments.length === 1 && segments[0] === 'node') {
      const consoleLines = await orchestrator.getConsoleStore().replay();
      const swarms = [];
      const challengeEntries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
      for (const entry of challengeEntries) {
        if (!entry.isDirectory()) continue;
        const evDir = path.join(challengesDir, entry.name, 'events');
        const files = await fs.readdir(evDir).catch(() => []);
        for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
          const events = await replay(path.join(evDir, f));
          if (!events.length) continue;
          const lastUpdate = [...events].reverse().find((e) => e.type === 'swarm.update');
          swarms.push({
            id: f.replace(/\.jsonl$/, ''),
            challenge: entry.name,
            status: lastUpdate?.data?.status ?? 'planning',
            flagsCount: events.filter((e) => e.type === 'flag.found').length
          });
        }
      }
      return sendJson(res, 200, {
        guard: guardLedger.defaultMode,
        pending: guardLedger.snapshot(),
        consoleThread: consoleLines.slice(-40),
        swarms
      });
    }

    throw httpError('not_found', `no route for ${req.method} ${pathname}`);
  }

  function sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    });
    res.end(body);
  }

  const requestHandler = (req, res) => handle(req, res).catch((e) => {
    const code = e?.code ?? 'internal';
    if (!res.headersSent) {
      const notFound = ['swarm_unknown', 'challenge_unknown', 'worker_unknown', 'not_found', 'bundle_empty', 'action_unknown'];
      const badRequest = ['bad_json', 'bad_request', 'payload_too_large', 'provider_key_missing', 'provider_key_invalid', 'provider_role_unconfigured'];
      const status = notFound.includes(code) ? 404
        : badRequest.includes(code) ? 400
        : code === 'unauthorized' ? 401
        : code === 'bundle_not_terminal' ? 409
        : code === 'action_superseded' ? 410
        : code === 'provider_http' ? 502
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
    gated,
    get url() { return `http://127.0.0.1:${config.port}/`; },
    get dashboardUrl() { return gated ? `http://127.0.0.1:${config.port}/?token=${token}` : `http://127.0.0.1:${config.port}/`; },
    listen,
    close
  };
}
