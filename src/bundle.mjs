import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { openEventStore, replayFile } from './store.mjs'; // replayFile added below
import { nowIso, ensureDir } from './util.mjs';

/**
 * Review bundle: a single .tar.gz per swarm holding everything a CTF
 * write-up needs — post-mortem, the transcripts of workers that found
 * flags, every captured diff, the shared findings log, and the flags
 * extracted from the event store. USTAR + gzip are hand-built so the
 * engine keeps its zero-dependency guarantee.
 */

/** One octal field per POSIX USTAR: digits + NUL, fixed width. */
function octal(value, width) {
  const digits = Math.max(0, value).toString(8);
  const room = width - 1; // trailing byte stays NUL
  if (digits.length > room) return '7'.repeat(room);
  return digits.padStart(room, '0');
}

function headerBytes(entry) {
  const buf = Buffer.alloc(512, 0);
  buf.write(entry.name.slice(0, 100), 0, 100, 'utf8');           // name
  buf.write(octal(entry.mode ?? 0o644, 8), 100, 'utf8');         // mode
  buf.write(octal(entry.uid ?? 0, 8), 108, 'utf8');               // uid
  buf.write(octal(entry.gid ?? 0, 8), 116, 'utf8');               // gid
  buf.write(octal(entry.size, 12), 124, 'utf8');                  // size
  buf.write(octal(entry.mtime ?? Math.floor(Date.now() / 1000), 12), 136, 'utf8'); // mtime
  buf.write(' '.repeat(8), 148, 'utf8');                          // chksum as spaces
  buf.write('0', 156, 'utf8');                                    // typeflag: regular
  buf.write('ustar', 257, 'utf8');                                // magic
  buf.write('00', 263, 'utf8');                                   // version
  const chksum = buf.reduce((n, b) => n + b, 0);                  // spaces already in the buffer
  buf.write(octal(chksum, 8), 148, 'utf8');
  return buf;
}

function tarEntry(name, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const header = headerBytes({ name, size: body.length });
  const padLen = (512 - (body.length % 512)) % 512;
  return Buffer.concat([header, body, Buffer.alloc(padLen, 0)]);
}

/** Locate a swarm's on-disk home by scanning the workspace. */
async function locateSwarm(workspaceDir, swarmId) {
  if (!/^[\w-]+$/.test(swarmId)) return null;
  const challengesDir = path.join(workspaceDir, 'challenges');
  const entries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storeFile = path.join(challengesDir, entry.name, 'events', `${swarmId}.jsonl`);
    const exists = await fs.stat(storeFile).then(() => true).catch(() => false);
    if (exists) return { challengeId: entry.name, chDir: path.join(challengesDir, entry.name), storeFile };
  }
  return null;
}

export async function buildBundle({ swarmId, workspaceDir, bus }) {
  const rec = await locateSwarm(workspaceDir, swarmId);
  if (!rec) {
    throw Object.assign(new Error(`unknown swarm ${swarmId}`), { code: 'swarm_unknown' });
  }

  const events = await replayFile(rec.storeFile);
  if (!events.length) {
    throw Object.assign(new Error(`swarm ${swarmId} has an empty event store`), { code: 'bundle_empty' });
  }

  // Terminal-only: a bundle is a review artifact; in-flight swarms would ship
  // a moving snapshot of artifacts that are still being written.
  const lastUpdate = [...events].reverse().find((e) => e.type === 'swarm.update');
  if (!lastUpdate?.data?.final) {
    throw Object.assign(new Error(`swarm ${swarmId} is not terminal yet`), { code: 'bundle_not_terminal' });
  }

  const flags = events
    .filter((e) => e.type === 'flag.found')
    .map((e) => ({ workerId: e.worker ?? e.data.workerId, flag: e.data.flag, formatMatch: e.data.formatMatch, reasoning: e.data.reasoning, t: e.t }));
  const solvedWorkers = [...new Set(flags.map((f) => f.workerId).filter(Boolean))];
  const postmortemPath = [...events].reverse().find((e) => e.type === 'swarm.postmortem')?.data?.path ?? null;

  const entries = [];
  const addFile = async (name, file, { optional = false } = {}) => {
    const data = await fs.readFile(file).catch(() => null);
    if (data === null) {
      if (!optional) return false;
      return false;
    }
    entries.push(tarEntry(name, data));
    return true;
  };

  // postmortem.md
  if (postmortemPath) await addFile('postmortem.md', postmortemPath);
  // solved worker transcripts
  for (const wid of solvedWorkers) {
    await addFile(`transcripts/${wid}.jsonl`, path.join(rec.chDir, 'transcripts', `${wid}.jsonl`), { optional: true });
  }
  // all captured diffs
  const diffsDir = path.join(rec.chDir, 'diffs');
  const diffFiles = await fs.readdir(diffsDir).catch(() => []);
  for (const f of diffFiles.filter((x) => x.endsWith('.diff'))) {
    await addFile(`diffs/${f}`, path.join(diffsDir, f), { optional: true });
  }
  // notes.jsonl + flags.json
  await addFile('notes.jsonl', path.join(rec.chDir, 'notes.jsonl'), { optional: true });
  entries.push(tarEntry('flags.json', JSON.stringify({ swarm: swarmId, challenge: rec.challengeId, generatedAt: nowIso(), flags }, null, 2) + '\n'));

  // End-of-archive: two zero blocks.
  const tar = Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
  const gz = zlib.gzipSync(tar, { mtime: 0 });

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const bundlesDir = path.join(rec.chDir, 'bundles');
  await ensureDir(bundlesDir);
  const outFile = path.join(bundlesDir, `${swarmId}-${day}.tar.gz`);
  await fs.writeFile(outFile, gz);
  const out = { path: outFile, bytes: gz.length, files: entries.length };

  // bundle.exported lands in the store so any replay/SSE recap carries it.
  const store = await openEventStore(rec.storeFile, { swarmId });
  const ev = await store.append({ type: 'bundle.exported', swarm: swarmId, challenge: rec.challengeId, data: { path: outFile, bytes: out.bytes, files: out.files } });
  bus?.publish(ev);
  return out;
}
