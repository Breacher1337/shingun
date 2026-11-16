import { denylistHit } from './jail.mjs';
import { execCommand } from './shell.mjs';

/**
 * Runner interface: LocalRunner is the shipped implementation; a Docker
 * runner slots in later without touching agent logic. On Linux with
 * runner.useSystemdScope, commands run under a systemd --user scope so
 * systemd-oomd kills hangups surgically.
 */
export function createLocalRunner({ config }) {
  const opts = config.runner ?? { useSystemdScope: false, scopeMemoryMaxMb: 1024 };
  async function run(cmd, { cwd, timeoutSec = config.worker.commandTimeoutSec, outputCap = config.worker.commandOutputCap } = {}) {
    const hit = denylistHit(cmd, config.denylist);
    if (hit) {
      return { exitCode: 126, stdout: `DENYLIST: ${JSON.stringify(hit)}`, stderr: '', truncated: false, durationMs: 0 };
    }
    let finalCmd = cmd;
    if (opts.useSystemdScope && process.platform === 'linux') {
      finalCmd = `systemd-run --user --scope -p MemoryMax=${opts.scopeMemoryMaxMb}M -p TimeoutSec=${timeoutSec}s -- ${cmd}`;
    }
    return execCommand(finalCmd, { cwd, timeoutSec, outputCap });
  }
  return { run };
}
