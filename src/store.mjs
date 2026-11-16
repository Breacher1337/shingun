import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from './util.mjs';

/**
 * Append-only JSONL event store, one file per swarm. The store is the source
 * of truth: append first, then the bus publishes the stored bytes.
 */
export async function openEventStore(file, { swarmId } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let seq = 0;
  try {
    const text = await fs.readFile(file, 'utf8');
    seq = text.split('\n').filter((l) => l.trim()).length;
  } catch { /* fresh store */ }

  async function append(event) {
    seq += 1;
    const full = {
      v: 1,
      id: event.id ?? `${swarmId}-${String(seq).padStart(5, '0')}`,
      t: event.t ?? nowIso(),
      type: event.type,
      challenge: event.challenge ?? null,
      swarm: event.swarm ?? swarmId ?? null,
      worker: event.worker ?? null,
      data: event.data ?? {}
    };
    await fs.appendFile(file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  return {
    file,
    append,
    async replay() {
      const text = await fs.readFile(file, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip corrupt tail line */ }
      }
      return out;
    }
  };
}
