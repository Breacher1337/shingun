import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-platform command execution: timeout, output caps, tree kill.
 * POSIX: detached process group, SIGTERM → (2s) → SIGKILL.
 * Windows: taskkill /T /F walks the tree.
 *
 * Shell choice: on Windows, bash.exe (ships with Git for Windows) is
 * preferred so quoting behaves like the Linux target; cmd.exe is the
 * fallback when no bash is on PATH.
 */
let resolvedShell = null;
function resolveShell() {
  if (resolvedShell) return resolvedShell;
  if (process.platform !== 'win32') {
    resolvedShell = { cmd: '/bin/sh', args: ['-c'] };
    return resolvedShell;
  }
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const candidate of gitBashCandidates) {
    if (fs.existsSync(candidate)) {
      resolvedShell = { cmd: candidate, args: ['-c'] };
      return resolvedShell;
    }
  }
  const onPath = (process.env.PATH ?? '').split(';').map((p) => p.trim()).find((dir) => {
    if (!dir || /WindowsApps/i.test(dir)) return false;
    try {
      return fs.existsSync(`${dir}\\bash.exe`) || fs.existsSync(`${dir}/bash.exe`);
    } catch { return false; }
  });
  if (onPath) {
    const full = fs.existsSync(`${onPath}\\bash.exe`) ? `${onPath}\\bash.exe` : `${onPath}/bash.exe`;
    resolvedShell = { cmd: full, args: ['-c'] };
  } else {
    resolvedShell = { cmd: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c'] };
  }
  return resolvedShell;
}

/** Shell command with argv array: no quoting fragility for git plumbing. */
export function execDirect(cmd, args, { cwd, timeoutSec = 60, outputCap = 10240 } = {}) {
  return runProcess(cmd, args, { cwd, timeoutSec, outputCap, detached: false });
}

export function execCommand(cmd, { cwd, timeoutSec = 60, outputCap = 10240 } = {}) {
  const sh = resolveShell();
  return runProcess(sh.cmd, [...sh.args, cmd], {
    cwd, timeoutSec, outputCap,
    detached: process.platform !== 'win32' && sh.cmd === '/bin/sh'
  });
}

function runProcess(cmd, args, { cwd, timeoutSec, outputCap, detached }) {
  // Commands run machine-in-the-loop: their output feeds worker context and
  // tests, so it must stay plain regardless of the operator's color env.
  // FORCE_COLOR/CLICOLOR_FORCE can bleed in and make children emit ANSI even
  // through pipes; NO_COLOR keeps grandchildren deterministic too.
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  env.NO_COLOR = '1';
  const nodeDir = path.dirname(process.execPath);
  if (nodeDir) {
    const currentPaths = (env.PATH ?? '').split(path.delimiter);
    if (!currentPaths.includes(nodeDir)) {
      env.PATH = `${nodeDir}${path.delimiter}${env.PATH ?? ''}`;
    }
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      detached,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let killer = null;

    const killTree = () => {
      if (child.killed || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    };

    child.stdout.on('data', (d) => {
      if (out.length + d.length > outputCap) truncated = true;
      if (out.length < outputCap) {
        out = Buffer.concat([out, d.subarray(0, outputCap - out.length)]);
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length + d.length > outputCap) truncated = true;
      if (err.length < outputCap) {
        err = Buffer.concat([err, d.subarray(0, outputCap - err.length)]);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
        killer = setTimeout(killTree, 2000);
      } else {
        killTree();
      }
    }, timeoutSec * 1000);

    const finish = (exitCode) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      let stderr = err.toString('utf8');
      if (timedOut) stderr += `\nshingun: command timeout after ${timeoutSec}s`;
      resolve({
        exitCode: exitCode == null ? (timedOut ? 124 : 1) : exitCode,
        stdout: out.toString('utf8'),
        stderr,
        truncated,
        durationMs: Date.now() - started
      });
    };

    child.on('error', (e) => {
      resolve({
        exitCode: 127,
        stdout: '',
        stderr: `shingun: spawn failed: ${e.message}`,
        truncated: false,
        durationMs: Date.now() - started
      });
    });
    child.on('close', finish);
  });
}
