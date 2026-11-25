#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs, { mkdir } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { ingestChallenge } from '../src/ingest.mjs';
import { replayFile } from '../src/store.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Digest a swarm store into a compact status line (CLI status output). */
async function statusScan(workspaceDir) {
  const out = [];
  const challengesDir = path.join(workspaceDir, 'challenges');
  const entries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const evDir = path.join(challengesDir, entry.name, 'events');
    const files = await fs.readdir(evDir).catch(() => []);
    for (const f of files.filter((x) => x.endsWith('.jsonl') && x !== 'mcp.jsonl')) {
      const swarmId = f.replace(/\.jsonl$/, '');
      const events = await replayFile(path.join(evDir, f)).catch(() => []);
      if (!events.length) continue;
      const lastUpdate = [...events].reverse().find((e) => e.type === 'swarm.update');
      const flags = events.filter((e) => e.type === 'flag.found').map((e) => e.data.flag);
      const workers = new Map();
      for (const e of events) {
        if (!e.worker) continue;
        const w = workers.get(e.worker) ?? { id: e.worker, persona: null, status: null };
        if (e.type === 'worker.spawn') w.persona = e.data.persona;
        if (e.type === 'worker.status') w.status = e.data.status;
        workers.set(e.worker, w);
      }
      out.push({
        swarmId,
        challengeId: entry.name,
        status: lastUpdate?.data?.final ? lastUpdate.data.status : (lastUpdate?.data?.status ?? 'planning'),
        final: Boolean(lastUpdate?.data?.final),
        flags,
        workers: [...workers.values()]
      });
    }
  }
  return out;
}

/**
 * Relay a call to a running `serve` process on localhost. Swarms started by
 * `serve` live in that process — a fresh CLI reaches them only through the
 * server's HTTP surface, authenticated with the operator's bearer token.
 */
async function serveRelay(method, routePath, body, config, env) {
  const base = `http://127.0.0.1:${config.port}`;
  const token = env?.SHINGUN_TOKEN;
  let res;
  try {
    res = await fetch(base + routePath, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error(`no shingun serve process on ${base}`), { code: 'serve_unreachable' });
  }
  if (res.status === 401) {
    throw Object.assign(new Error('the serve process is token-gated; set SHINGUN_TOKEN in .env'), { code: 'serve_gated' });
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error?.message ?? `serve relay: ${res.status}`), { code: payload?.error?.code ?? 'serve_relay_failed' });
  }
  return payload;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const key = camel(a.slice(2));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage(code = 1) {
  process.stdout.write(
    `shingun (進軍) — headless CTF tool server & swarm runner on localhost

Usage:
  shingun serve [--port N] [--profile P] [--config FILE] [--workspace DIR]
  shingun mcp [--profile P] [--config FILE] [--workspace DIR]
  shingun run <repoUrl|localPath|archiveUrl> [--target URL] [--target-note NOTE] [--challenge-id ID] [--workers N] [--flag-format REGEX] [--category C] [--profile P] [--config FILE] [--workspace DIR]
  shingun status [--workspace DIR]
  shingun init-config
  shingun bundle <swarmId> [--workspace DIR]
  shingun master <swarmId> <directive>
  shingun steer <swarmId> <workerId> <text>
`);
  process.exit(code);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const profile = typeof args.profile === 'string' ? args.profile : undefined;
  // --config FILE: load operator config from anywhere instead of <repo>/config.json.
  const configFile = typeof args.config === 'string' ? path.resolve(args.config) : path.join(HERE, 'config.json');
  const { config, env } = await loadConfig({
    file: configFile,
    profile,
    envFile: path.join(HERE, '.env')
  });
  const workspaceDir = typeof args.workspace === 'string'
    ? path.resolve(args.workspace)
    : path.resolve(HERE, config.workspace);
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir, env, bus });

  switch (cmd) {
    case 'init-config': {
      const { writeJson } = await import('../src/util.mjs');
      await writeJson(path.join(HERE, 'config.json'), config);
      process.stdout.write(`wrote ${path.join(HERE, 'config.json')} (profile: ${config.profile})\n`);
      process.exit(0);
      break;
    }
    case 'run': {
      const sourceArg = args._[0];
      // The live-service pointer (--target URL): optional on any source, and
      // the whole challenge when no files are given at all.
      let liveTarget = null;
      if (typeof args.target === 'string' && args.target) {
        const isHttp = /^https?:\/\/.+/i.test(args.target);
        const isTcp = /^tcp:\/\/[A-Za-z0-9._\-]+:\d{1,5}(\/.*)?$/i.test(args.target);
        if (!isHttp && !isTcp) {
          throw new Error('--target must be http(s)://<host> or tcp://<host>:<port> — the live service the challenge runs at');
        }
        liveTarget = { url: args.target };
        if (typeof args.targetNote === 'string' && args.targetNote) {
          liveTarget.note = args.targetNote.slice(0, 500);
        }
      }
      if (!sourceArg && !liveTarget) usage(1);
      // CLI stdout is the JSONL event stream — nothing else may print.
      // If the consumer goes away (EPIPE), stop streaming but let the swarm
      // finish and write its workspace artifacts.
      let streamDown = false;
      const unsub = bus.subscribe((ev) => {
        if (streamDown) return;
        try {
          process.stdout.write(JSON.stringify(ev) + '\n');
        } catch { streamDown = true; }
      });
      process.stdout.on('error', (e) => {
        if (e.code === 'EPIPE') streamDown = true;
      });
      const isUrl = /^https?:\/\//.test(sourceArg);
      const isArchiveUrl = isUrl && /\.(tar\.gz|tgz)$/i.test(String(sourceArg).split(/[?#]/)[0]);
      const challengesDir = path.join(workspaceDir, 'challenges');
      await mkdir(challengesDir, { recursive: true });
      const ing = await ingestChallenge({
        source: !sourceArg ? 'none' : isArchiveUrl ? 'download' : isUrl ? 'url' : 'path',
        value: sourceArg, challengesDir, target: liveTarget,
        challengeId: typeof args.challengeId === 'string' ? args.challengeId : undefined
      });
      // Operator-known challenge metadata: declared values bypass master
      // inference (triage reports source "declared") and steer personas.
      let flagFormatRegex = null;
      if (typeof args.flagFormat === 'string' && args.flagFormat) {
        try { new RegExp(args.flagFormat); }
        catch (e) { throw new Error(`invalid --flag-format regex: ${e.message}`); }
        flagFormatRegex = args.flagFormat;
      }
      const categoryHint = typeof args.category === 'string' && args.category ? args.category : null;
      const { swarmId } = await orch.startSwarm({
        challenge: {
          id: ing.challengeId,
          sourceType: ing.target && !sourceArg ? 'none' : isArchiveUrl ? 'download' : isUrl ? 'url' : 'path',
          sourceValue: sourceArg,
          baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles,
          target: ing.target ?? null, flagFormatRegex, categoryHint
        },
        opts: {
          workers: typeof args.workers === 'string' ? Number(args.workers) : undefined,
          budgetUsd: typeof args.budgetUsd === 'string' ? Number(args.budgetUsd) : undefined
        }
      });
      const s = orch.swarms.get(swarmId);
      // Wait for the swarm's completion promise (post-mortem + final event
      // flushed) instead of polling status — a status poll can exit before
      // the post-mortem lands. Watchdog guards against a hung swarm.
      const watchdogMs = (config.worker.wallClockMin * 60 + 120) * 1000;
      await Promise.race([
        s.done,
        new Promise((resolve) => {
          const t = setTimeout(resolve, watchdogMs);
          t.unref?.();
        })
      ]);
      unsub();
      process.exit(0);
      break;
    }
    case 'status': {
      // Status is a pure read of the workspace stores: a fresh CLI process
      // has no in-memory swarms, so the event stores on disk ARE the state.
      for (const line of await statusScan(workspaceDir)) {
        process.stdout.write(JSON.stringify(line) + '\n');
      }
      process.exit(0);
      break;
    }
    case 'bundle': {
      const [swarmId] = args._;
      if (!swarmId) usage(1);
      const { buildBundle } = await import('../src/bundle.mjs');
      const out = await buildBundle({ swarmId, workspaceDir, bus });
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(0);
      break;
    }
    case 'master': {
      const [swarmId, ...words] = args._;
      if (!swarmId || !words.length) usage(1);
      const text = words.join(' ');
      try {
        const res = await orch.directive(swarmId, text);
        process.stdout.write(JSON.stringify(res) + '\n');
      } catch (e) {
        if (e.code !== 'swarm_unknown') throw e;
        // Not in this process: a running `serve` owns it — relay over HTTP.
        const out = await serveRelay('POST', '/api/v1/master/messages', { swarm: swarmId, text }, config, env);
        process.stdout.write(JSON.stringify({ ok: out.ok, via: 'serve' }) + '\n');
      }
      process.exit(0);
      break;
    }
    case 'steer': {
      const [swarmId, workerId, ...words] = args._;
      if (!swarmId || !workerId || !words.length) usage(1);
      try {
        const out = await orch.steerWorker(swarmId, workerId, words.join(' '));
        process.stdout.write(JSON.stringify(out) + '\n');
      } catch (e) {
        if (e.code !== 'worker_unknown' && e.code !== 'swarm_unknown') throw e;
        const out = await serveRelay(
          'POST',
          `/api/v1/swarms/${encodeURIComponent(swarmId)}/workers/${encodeURIComponent(workerId)}/messages`,
          { text: words.join(' ') }, config, env
        );
        process.stdout.write(JSON.stringify({ ...out, via: 'serve' }) + '\n');
      }
      process.exit(0);
      break;
    }
    case 'serve': {
      const { startServer } = await import('../src/server.mjs');
      const resumed = await orch.resume();
      const port = typeof args.port === 'string' ? Number(args.port) : config.port;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`shingun: invalid port ${args.port}\n`);
        process.exit(1);
      }
      const srv = await startServer({
        config, env, orchestrator: orch, bus, workspaceDir,
        envFile: path.join(HERE, '.env'),
        configFile
      });
      await srv.listen(port);
      process.stdout.write(`shingun (進軍) serving on ${srv.url}\n`);
      process.stdout.write(`status: ${srv.url}\n`);
      process.stdout.write(`mcp: ${srv.url}mcp\n`);
      process.stdout.write(srv.gated
        ? `auth: token-gated (SHINGUN_TOKEN from .env)\n`
        : `auth: open workspace (set SHINGUN_TOKEN in .env to gate this server)\n`);
      if (resumed.length) {
        process.stdout.write(`resumed swarms (in-flight before restart): ${resumed.join(', ')}\n`);
      }
      const shutdown = () => {
        srv.close().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'mcp': {
      const { createMcpServer } = await import('../src/mcp.mjs');
      const mcp = createMcpServer({ orchestrator: orch, bus, workspaceDir });
      process.on('SIGINT', () => { mcp.closeAll(); process.exit(0); });
      process.on('SIGTERM', () => { mcp.closeAll(); process.exit(0); });
      await mcp.serveStdio();
      process.exit(0);
      break;
    }
    default:
      usage(1);
  }
}

main().catch((e) => {
  process.stderr.write(`shingun: ${e.message}\n`);
  process.exit(1);
});
