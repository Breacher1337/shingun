import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

export const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Truncate a string to at most `capBytes` of UTF-8, marking the cut. */
export function truncateBytes(text, capBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= capBytes) {
    return { text: buf.toString('utf8'), truncated: false, omittedBytes: 0 };
  }
  const cut = buf.slice(0, capBytes).toString('utf8');
  return {
    text: cut + `\n…[truncated ${buf.length - capBytes} bytes]`,
    truncated: true,
    omittedBytes: buf.length - capBytes,
  };
}

/** Parse "MemAvailable:  N kB" from /proc/meminfo text; returns MB or null. */
export function parseMemAvailable(meminfoText) {
  const m = /MemAvailable:\s+(\d+)\s*kB/.exec(String(meminfoText ?? ''));
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** Count files (recursive) and return up to `take` relative paths. */
export async function listTree(root, { skipDirs = ['.git', 'node_modules'], maxDepth = 3 } = {}) {
  const files = [];
  async function walk(dir, rel, depth) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDirs.includes(e.name) && depth < maxDepth) {
          await walk(path.join(dir, e.name), r, depth + 1);
        }
      } else {
        files.push(r);
      }
    }
  }
  await walk(root, '', 0);
  return { fileCount: files.length, topFiles: files.slice(0, 40) };
}
