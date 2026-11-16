import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

export const NODE = process.execPath;
export const BIN = path.join(ROOT, 'bin', 'shingun.mjs');
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'challenge-easy');

export async function tmpWorkspace(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `shingun-${tag}-`));
}

/** Run the CLI as a real child process; returns {code, events, stderr}. */
export function runCli(args, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = out.split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      resolve({ code, events, stderr: err });
    });
    child.on('error', reject);
  });
}
