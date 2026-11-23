#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs, { mkdir } from 'node:fs/promises';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
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
    for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
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
      const usage = events.filter((e) => e.type === 'usage.tick').reduce((n, e) => n + (Number(e.data.costUsd) || 0), 0);
      out.push({
        swarmId,
        challengeId: entry.name,
        status: lastUpdate?.data?.final ? lastUpdate.data.status : (lastUpdate?.data?.status ?? 'planning'),
        final: Boolean(lastUpdate?.data?.final),
        flags,
        workers: [...workers.values()],
        spentUsd: Number(usage.toFixed(5))
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
  if (!token) {
    throw Object.assign(new Error('no running serve process is reachable and no SHINGUN_TOKEN is configured'), { code: 'serve_unreachable' });
  }
  let res;
  try {
    res = await fetch(base + routePath, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error(`no shingun serve process on ${base}`), { code: 'serve_unreachable' });
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
    `shingun (進軍) — swarm CTF attacks on localhost

Usage:
  shingun run <repoUrl|localPath> [--challenge-id ID] [--workers N] [--budget-usd X] [--flag-format REGEX] [--category C] [--profile P] [--config FILE] [--workspace DIR]
  shingun serve [--port N] [--profile P] [--config FILE] [--workspace DIR]
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
  const workspaceDir = resolveWorkspace(config, typeof args.workspace === 'string' ? args.workspace : null);
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
      const target = args._[0];
      if (!target) usage(1);
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
      const isUrl = /^https?:\/\//.test(target);
      const challengesDir = path.join(workspaceDir, 'challenges');
      await mkdir(challengesDir, { recursive: true });
      const ing = await ingestChallenge({
        source: isUrl ? 'url' : 'path', value: target, challengesDir,
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
          id: ing.challengeId, sourceType: isUrl ? 'url' : 'path', sourceValue: target,
          baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles,
          flagFormatRegex, categoryHint
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
        const out = await serveRelay('POST', '/api/master/message', { swarm: swarmId, text }, config, env);
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
          `/api/swarms/${encodeURIComponent(swarmId)}/workers/${encodeURIComponent(workerId)}/message`,
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
        webDir: path.join(HERE, 'web'),
        configFile
      });
      await srv.listen(port);
      process.stdout.write(`shingun (進軍) serving on ${srv.url}\n`);
      if (srv.tokenGenerated) {
        process.stdout.write(`generated bearer token and saved it to ${path.join(HERE, '.env')}\n`);
      }
      process.stdout.write(`dashboard: ${srv.dashboardUrl}\n`);
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
    default:
      usage(1);
  }
}

main().catch((e) => {
  process.stderr.write(`shingun: ${e.message}\n`);
  process.exit(1);
});
