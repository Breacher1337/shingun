import fs from 'node:fs/promises';
import { parseMemAvailable } from './util.mjs';

/**
 * Adaptive admission: workers admit while MemAvailable stays above the
 * configured watermark; the static machine cap is the outer bound. Hosts
 * without /proc/meminfo (non-Linux dev machines) skip the gate.
 */
export async function sampleMemAvailable(meminfoPath) {
  try {
    const text = await fs.readFile(meminfoPath, 'utf8');
    return parseMemAvailable(text);
  } catch {
    return null;
  }
}

export async function admitWorker({ config, activeWorkers, sample = sampleMemAvailable, oomdKilled = false }) {
  if (!config.admission?.enabled) return { ok: true, reason: null, memAvailableMb: null };
  if (activeWorkers >= config.concurrency.machineWorkers) {
    return { ok: false, reason: 'cap', memAvailableMb: null };
  }
  const mem = await sample(config.admission.meminfoPath);
  if (mem == null) return { ok: true, reason: null, memAvailableMb: null };
  const watermark = config.admission.watermarkMb;
  // Every sample here is taken after any recorded oomd kill, so passing the
  // watermark already proves recovery; oomdKilled only matters for callers
  // tracking stricter local policy.
  void oomdKilled;
  if (mem < watermark) {
    return { ok: false, reason: 'watermark', memAvailableMb: mem, watermarkMb: watermark };
  }
  return { ok: true, reason: null, memAvailableMb: mem };
}
