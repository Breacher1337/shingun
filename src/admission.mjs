import fs from 'node:fs/promises';
import os from 'node:os';
import { parseMemAvailable } from './util.mjs';

let fallbackLogged = false;

/**
 * Adaptive admission: workers admit while MemAvailable stays above the
 * configured watermark; the static machine cap is the outer bound. Hosts
 * without /proc/meminfo use os.freemem() when admission.fallbackFreemem is true.
 */
export async function sampleMemAvailable(meminfoPath) {
  try {
    const text = await fs.readFile(meminfoPath, 'utf8');
    return parseMemAvailable(text);
  } catch {
    return null;
  }
}

export async function admitWorker({
  config,
  activeWorkers,
  sample = sampleMemAvailable,
  freemem = () => Math.round(os.freemem() / 1024 / 1024),
  onFallback,
  oomdKilled = false
}) {
  if (!config.admission?.enabled) return { ok: true, reason: null, memAvailableMb: null };
  if (activeWorkers >= config.concurrency.machineWorkers) {
    return { ok: false, reason: 'cap', memAvailableMb: null };
  }
  const watermark = config.admission.watermarkMb;
  const mem = await sample(config.admission.meminfoPath);
  if (mem == null) {
    if (!config.admission.fallbackFreemem) {
      return { ok: true, reason: null, memAvailableMb: null };
    }
    const freeMb = await freemem();
    if (!fallbackLogged) {
      fallbackLogged = true;
      const msg = `[admission] /proc/meminfo unavailable; using os.freemem() heuristic (${freeMb} MB free, watermark ${watermark} MB)`;
      process.stderr.write(msg + '\n');
      onFallback?.({ memAvailableMb: freeMb, watermarkMb: watermark, message: msg });
    }
    if (freeMb < watermark) {
      return { ok: false, reason: 'watermark-freemem', memAvailableMb: freeMb, watermarkMb: watermark };
    }
    return { ok: true, reason: null, memAvailableMb: freeMb };
  }
  // Every sample here is taken after any recorded oomd kill, so passing the
  // watermark already proves recovery; oomdKilled only matters for callers
  // tracking stricter local policy.
  void oomdKilled;
  if (mem < watermark) {
    return { ok: false, reason: 'watermark', memAvailableMb: mem, watermarkMb: watermark };
  }
  return { ok: true, reason: null, memAvailableMb: mem };
}
