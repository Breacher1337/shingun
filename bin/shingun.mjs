#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { ingestChallenge } from '../src/ingest.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

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
  shingun run <repoUrl|localPath> [--challenge-id ID] [--workers N] [--budget-usd X] [--profile P] [--config FILE] [--workspace DIR]
  shingun serve [--port N] [--profile P] [--config FILE] [--workspace DIR]
  shingun status [--workspace DIR]
  shingun init-config
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
      const { swarmId } = await orch.startSwarm({
        challenge: {
          id: ing.challengeId, sourceType: isUrl ? 'url' : 'path', sourceValue: target,
          baseDir: ing.baseDir, fileCount: ing.fileCount, topFiles: ing.topFiles,
          flagFormatRegex: null, categoryHint: null
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
      for (const sid of orch.emitAll()) {
        process.stdout.write(JSON.stringify(orch.statusSummary(sid)) + '\n');
      }
      process.exit(0);
      break;
    }
    case 'master': {
      const [swarmId, ...words] = args._;
      if (!swarmId || !words.length) usage(1);
      const res = await orch.directive(swarmId, words.join(' '));
      process.stdout.write(JSON.stringify(res) + '\n');
      process.exit(0);
      break;
    }
    case 'steer': {
      const [swarmId, workerId, ...words] = args._;
      if (!swarmId || !workerId || !words.length) usage(1);
      process.stdout.write(JSON.stringify(await orch.steerWorker(swarmId, workerId, words.join(' '))) + '\n');
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
        webDir: path.join(HERE, 'web')
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
