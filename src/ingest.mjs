import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync as fsSyncWrite } from 'node:fs';
const ensureDirSync = (dir) => mkdirSync(dir, { recursive: true });
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { execDirect } from './shell.mjs';
import { ensureDir, listTree, newId } from './util.mjs';

/**
 * Challenge ingest: normalize any source into a git base repo at
 * challenges/<id>/base, so the worktree pipeline is uniform across sources.
 *
 *   source: 'url'       git repository (shallow clone)
 *   source: 'path'      local folder (copied; git-initialized if needed)
 *                       OR a local file — a zip/tar.gz extracts into the
 *                       base, any other file lands as a single artifact
 *   source: 'download'  an http(s) download — zip and .tar.gz extract in
 *                       place (CRC-verified, zip-slip-guarded); any other
 *                       file is stored as a single artifact
 *   source: 'upload'    raw bytes from the operator (file picker): same
 *                       materialization as downloads, no network needed
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

export function validateTarget(target) {
  if (target === null || target === undefined) return null;
  if (typeof target !== 'object') throw httpError('bad_request', 'target must be {url, note?}');
  const url = String(target.url ?? '').trim();
  const isHttp = /^https?:\/\/.+/i.test(url);
  const isTcp = /^tcp:\/\/[A-Za-z0-9._\-]+:\d{1,5}(\/.*)?$/i.test(url);
  if (!isHttp && !isTcp) {
    throw httpError('bad_request', 'target.url must be http(s)://<host> or tcp://<host>:<port> — the live service the challenge runs at');
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

// CRC32 (IEEE 0xEDB88320) — ten lines, built once. The old "zip needs CRC
// machinery" note overstated the cost, so the most-copied archive format in
// CTF land now extracts like any other source.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Minimal zip reader: walks local file headers, extracts stored (0) and
 * deflate (8) entries, verifies each entry's CRC32, and refuses any entry
 * that would escape the extraction root. Entries written in streaming mode
 * (sizes parked in a data descriptor) are refused — every packager users
 * actually meet writes local sizes.
 */
function extractZip(buffer, destDir) {
  const destRoot = path.resolve(destDir);
  let wrote = 0;
  let off = 0;
  while (off + 4 <= buffer.length) {
    if (buffer.readUInt32LE(off) !== 0x04034b50) break; // local file signature
    if (off + 30 > buffer.length) throw httpError('ingest_zip_corrupt', 'truncated zip header');
    const flags = buffer.readUInt16LE(off + 6);
    const method = buffer.readUInt16LE(off + 8);
    const crcStored = buffer.readUInt32LE(off + 14);
    const cSize = buffer.readUInt32LE(off + 18);
    const uSize = buffer.readUInt32LE(off + 22);
    const nameLen = buffer.readUInt16LE(off + 26);
    const extraLen = buffer.readUInt16LE(off + 28);
    const name = buffer.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = dataStart + cSize;
    if (dataEnd > buffer.length) throw httpError('ingest_zip_corrupt', `truncated zip entry data: ${name}`);
    off = dataEnd;
    if (flags & 0x8) {
      throw httpError('ingest_zip_corrupt', `zip uses streamed sizes (data descriptor) which this reader refuses: ${name} — re-zip with a standard tool`);
    }
    // zip-slip guard: an entry may never escape the extraction root
    const resolved = path.resolve(destDir, name.replace(/^\/+/, ''));
    if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
      throw httpError('ingest_zip_corrupt', `zip entry escapes the archive root: ${name}`);
    }
    if (name.endsWith('/')) { ensureDirSync(resolved); continue; }
    if (method !== 0 && method !== 8) {
      throw httpError('ingest_zip_corrupt', `unsupported zip compression method ${method}: ${name}`);
    }
    const data = method === 8 ? inflateRawSync(buffer.subarray(dataStart, dataEnd)) : buffer.subarray(dataStart, dataEnd);
    if (data.length !== uSize) {
      throw httpError('ingest_zip_corrupt', `zip entry size mismatch: ${name}`);
    }
    if (crc32(data) !== crcStored) {
      throw httpError('ingest_zip_corrupt', `zip entry failed its CRC check: ${name}`);
    }
    ensureDirSync(path.dirname(resolved));
    fsSyncWrite(resolved, data);
    wrote += 1;
  }
  if (wrote === 0) throw httpError('ingest_zip_corrupt', 'zip contains no extractable entries');
  return wrote;
}

const looksArchiveZip = (filename, contentType) =>
  /\.zip$/i.test(filename) || /zip/i.test(contentType ?? '');
const looksArchiveGz = (filename, buffer) =>
  /\.(tar\.gz|tgz)$/i.test(filename) || (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);

/**
 * Put materialized bytes on disk — shared by URL downloads, raw uploads,
 * and local archive files. Zip extracts, tar.gz extracts, anything else
 * is stored as a single named artifact.
 */
function materializeBuffer(buffer, filename, baseDir, { contentType = '' } = {}) {
  if (looksArchiveZip(filename, contentType)) {
    const files = extractZip(buffer, baseDir);
    return { kind: 'archive', filename, files };
  }
  if (looksArchiveGz(filename, buffer)) {
    const tar = gunzipSync(buffer);
    const files = extractTar(tar, baseDir);
    if (files === 0) {
      throw httpError('ingest_download_failed', `archive ${filename} contains no extractable files`);
    }
    return { kind: 'archive', filename, files };
  }
  const safe = filename.replace(/[^\w.\-]/g, '_');
  ensureDirSync(baseDir);
  fsSyncWrite(path.join(baseDir, safe), buffer);
  return { kind: 'file', filename: safe };
}

async function materializeDownload(url, baseDir, maxBytes) {
  const { buffer, contentType } = await fetchCapped(url, maxBytes);
  return materializeBuffer(buffer, nameFromUrl(url), baseDir, { contentType });
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
  const isTcp = /^tcp:\/\//i.test(String(target?.url ?? ''));
  return [
    '# Live target',
    '',
    `This challenge includes a running service:`,
    '',
    `    ${target.url}`,
    '',
    target.note ? `Operator note: ${target.note}` : '',
    'The service is reachable over the network and is part of the',
    isTcp
      ? 'challenge; connect to it over raw TCP (e.g. tcp_session / nc). The host around it is out of scope.'
      : 'challenge; attack it over HTTP. The host around it is out of scope.'
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
  } else if (source === 'upload') {
    // Raw bytes uploaded from the dashboard (a file picker away): buffer +
    // filename; the caller caps the body at the same maxBytes ceiling.
    materializeBuffer(value.data, value.filename || 'upload.bin', baseDir);
  } else if (source === 'none') {
    await ensureDir(baseDir); // a pure live-web challenge: the base is just the target
  } else {
    const src = path.resolve(value);
    const stat = await fs.stat(src).catch(() => null);
    if (stat?.isFile()) {
      // A downloaded artifact (picoCTF ships zips): extract or store it.
      if (stat.size > maxBytes) {
        throw httpError('ingest_too_large', `local file exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB ingest cap: ${src}`);
      }
      materializeBuffer(await fs.readFile(src), path.basename(src), baseDir);
    } else if (stat?.isDirectory()) {
      const exists = await fs.stat(baseDir).then(() => true).catch(() => false);
      if (exists) {
        throw Object.assign(new Error(`challenge base already exists: ${baseDir}`), { code: 'ingest_bad_path' });
      }
      await fs.cp(src, baseDir, { recursive: true, force: true, errorOnExist: false });
    } else {
      throw Object.assign(new Error(`challenge path is neither a folder nor a file: ${src}`), { code: 'ingest_bad_path' });
    }
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
