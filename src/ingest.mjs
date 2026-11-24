import fs from 'node:fs/promises';
import { mkdirSync as ensureDirSync, writeFileSync as fsSyncWrite } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execDirect } from './shell.mjs';
import { ensureDir, listTree, newId } from './util.mjs';

/**
 * Challenge ingest: normalize any source into a git base repo at
 * challenges/<id>/base, so the worktree pipeline is uniform across sources.
 *
 *   source: 'url'       git repository (shallow clone)
 *   source: 'path'      local folder (copied; git-initialized if needed)
 *   source: 'download'  an http(s) download — a .tar.gz archive is
 *                       extracted in place; any other file is stored as a
 *                       single artifact. (zip is refused by name: it needs
 *                       CRC machinery the zero-dependency rule §0.1
 *                       deliberately refuses to hand-roll — repack as
 *                       .tar.gz.)
 *   source: 'none'      no files at all — a pure live-web challenge whose
 *                       target is the whole challenge.
 *
 * `target {url, note?}` is optional on every source and orthogonal to it:
 * a running service the challenge lives in or alongside. It is written
 * into the base repo as TARGET.md (so file-recon personas meet it), and the
 * orchestrator carries it into the master's triage and every worker's
 * system prompt. Downloads are capped: a challenge URL is untrusted input.
 */

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function httpError(code, message) {
  return Object.assign(new Error(message), { code });
}

function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() || 'download.bin';
    return decodeURIComponent(base);
  } catch {
    throw httpError('ingest_bad_url', `download url is not valid: ${url}`);
  }
}

function validateTarget(target) {
  if (target === null || target === undefined) return null;
  if (typeof target !== 'object') throw httpError('bad_request', 'target must be {url, note?}');
  const url = String(target.url ?? '').trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    throw httpError('bad_request', 'target.url must be an http(s) URL — the live service the challenge runs at');
  }
  const note = target.note === undefined || target.note === null ? null : String(target.note).slice(0, 500);
  return { url, note };
}

async function fetchCapped(url, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) {
    throw httpError('ingest_download_failed', `download failed: HTTP ${res.status} for ${url}`);
  }
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw httpError('ingest_too_large', `download exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB ingest cap — provide a smaller archive`);
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw httpError('ingest_download_failed', `download is empty: ${url}`);
  return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
}

// Minimal USTAR reader — 512-byte headers, the mirror of the hand-built
// writer in bundle.mjs. The walk is synchronous by nature (header → data →
// header) and stays small under the ingest cap. GNU long-name ('L') entries
// are not supported; standard tar archives produced by every packager work.
function oct(field) {
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function strn(field) {
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString('utf8');
}

function extractTar(buffer, destDir) {
  const destRoot = path.resolve(destDir);
  let wrote = 0;
  for (let off = 0; off + 512 <= buffer.length;) {
    const header = buffer.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = strn(header.subarray(0, 100));
    const size = oct(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = strn(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = off + 512;
    off = dataStart + Math.ceil(size / 512) * 512;
    // zip-slip guard: an entry may never escape the extraction root
    const resolved = path.resolve(destDir, fullName.replace(/^\/+/, ''));
    if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) continue;
    if (type === '5') {
      ensureDirSync(resolved);
      continue;
    }
    if (type !== '0' && type !== 0) continue; // links, devices, pax headers: skipped
    ensureDirSync(path.dirname(resolved));
    fsSyncWrite(resolved, buffer.subarray(dataStart, dataStart + size));
    wrote += 1;
  }
  return wrote;
}

async function materializeDownload(url, baseDir, maxBytes) {
  const { buffer, contentType } = await fetchCapped(url, maxBytes);
  const filename = nameFromUrl(url);
  const looksZip = /\.zip($|\?)/i.test(url) || /zip/i.test(contentType);
  if (looksZip) {
    throw httpError('ingest_zip_unsupported',
      `\"${filename}\" is a zip archive — zip needs CRC machinery the zero-dependency rule refuses to hand-roll (§10). Repack it as .tar.gz and download that.`);
  }
  if (/\.(tar\.gz|tgz)$/i.test(filename) || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
    const tar = gunzipSync(buffer);
    const files = extractTar(tar, baseDir);
    if (files === 0) {
      throw httpError('ingest_download_failed', `archive ${filename} contains no extractable files`);
    }
    return { kind: 'archive', filename, files };
  }
  const safe = filename.replace(/[^\w.\-]/g, '_');
  await ensureDir(baseDir);
  await fs.writeFile(path.join(baseDir, safe), buffer);
  return { kind: 'file', filename: safe };
}

async function normalizeRepo(baseDir) {
  const hasGit = await fs.stat(path.join(baseDir, '.git')).then(() => true).catch(() => false);
  if (!hasGit) {
    await execDirect('git', ['init'], { cwd: baseDir, timeoutSec: 30, outputCap: 2048 });
  }
  await execDirect('git', ['add', '-A'], { cwd: baseDir, timeoutSec: 60, outputCap: 2048 });
  const commit = await execDirect(
    'git', ['-c', 'user.name=shingun', '-c', 'user.email=shingun@local', 'commit', '-m', 'shingun: normalized challenge base'],
    { cwd: baseDir, timeoutSec: 60, outputCap: 2048 }
  );
  // "nothing to commit" is fine for an empty-but-git repo
  if (commit.exitCode !== 0 && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
    throw Object.assign(new Error(`git commit failed: ${commit.stderr}`), { code: 'ingest_commit_failed' });
  }
}

export function targetMarkdown(target) {
  return [
    '# Live target',
    '',
    `This challenge includes a running service:`,
    '',
    `    ${target.url}`,
    '',
    target.note ? `Operator note: ${target.note}` : '',
    'The service is reachable over the network and is part of the',
    'challenge; attack it over HTTP. The host around it is out of scope.'
  ].filter(Boolean).join('\n') + '\n';
}

export async function ingestChallenge({ source, value, challengesDir, challengeId, target, maxBytes = DEFAULT_MAX_BYTES }) {
  const id = challengeId ?? newId('ch');
  const safeTarget = validateTarget(target);
  const baseDir = path.join(challengesDir, id, 'base');
  await ensureDir(path.dirname(baseDir));

  if (source === 'url') {
    // URL ending in a downloadable archive is a download, not a git repo.
    if (/\.(tar\.gz|tgz|zip)$/i.test(String(value).split(/[?#]/)[0])) {
      throw httpError('bad_request', `use source \"download\" for archive URLs — \"url\" is for git repositories`);
    }
    const res = await execDirect('git', ['clone', '--depth', '50', value, baseDir], { timeoutSec: 300, outputCap: 4096 });
    if (res.exitCode !== 0) {
      throw Object.assign(new Error(`git clone failed: ${res.stderr}`), { code: 'ingest_clone_failed' });
    }
  } else if (source === 'download') {
    await materializeDownload(String(value).trim(), baseDir, maxBytes);
  } else if (source === 'none') {
    await ensureDir(baseDir); // a pure live-web challenge: the base is just the target
  } else {
    const src = path.resolve(value);
    const stat = await fs.stat(src).catch(() => null);
    if (!stat?.isDirectory()) {
      throw Object.assign(new Error(`challenge path is not a directory: ${src}`), { code: 'ingest_bad_path' });
    }
    const exists = await fs.stat(baseDir).then(() => true).catch(() => false);
    if (exists) {
      throw Object.assign(new Error(`challenge base already exists: ${baseDir}`), { code: 'ingest_bad_path' });
    }
    await fs.cp(src, baseDir, { recursive: true, force: true, errorOnExist: false });
  }

  if (safeTarget) {
    await fs.writeFile(path.join(baseDir, 'TARGET.md'), targetMarkdown(safeTarget), 'utf8');
  }

  if (source !== 'url') {
    await normalizeRepo(baseDir);
  }

  const { fileCount, topFiles } = await listTree(baseDir);
  return { challengeId: id, baseDir, fileCount, topFiles, target: safeTarget };
}
