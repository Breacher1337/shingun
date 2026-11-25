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
      return replayFile(file);
    }
  };
}

/** Parse a store file into events; corrupt tail lines are skipped. */
export async function replayFile(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt tail line */ }
  }
  return out;
}

/** Locate a swarm event store by swarm id on disk. */
export async function locateSwarm(challengesDir, swarmId) {
  if (!/^[\w-]+$/.test(swarmId ?? '') || swarmId === 'mcp') return null;
  const entries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storeFile = path.join(challengesDir, entry.name, 'events', `${swarmId}.jsonl`);
    const exists = await fs.stat(storeFile).then(() => true).catch(() => false);
    if (exists) {
      return {
        swarmId,
        challengeId: entry.name,
        chDir: path.join(challengesDir, entry.name),
        storeFile
      };
    }
  }
  return null;
}

/** Monotonic sequence number from an event id ("<swarmId>-00042"). */
export function eventSeq(event) {
  const m = /-(\d+)$/.exec(String(event?.id ?? ''));
  return m ? Number(m[1]) : 0;
}

/** Reconstruct swarm state by replaying its event store (budget-free). */
export function rebuildSwarmState(swarmId, challengeId, events) {
  const workers = new Map();
  const worker = (id) => {
    if (!workers.has(id)) {
      workers.set(id, {
        id,
        persona: '(unknown)',
        status: 'spawning',
        steps: 0,
        tokensIn: 0,
        tokensOut: 0,
        seenAt: null,
        diff: null,
        tools: [],
        logs: [],
        flags: [],
        stallChecks: 0
      });
    }
    return workers.get(id);
  };
  const state = {
    swarmId,
    challengeId,
    status: 'planning',
    final: false,
    startedAt: events[0]?.t ?? nowIso(),
    updatedAt: events[events.length - 1]?.t ?? nowIso(),
    challenge: { sourceType: null, sourceValue: null, category: null, flagFormat: null },
    triage: null,
    flags: [],
    masterChat: [],
    admission: null,
    postmortem: null,
    capNote: null
  };
  let lastSeq = 0;
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, eventSeq(ev));
    const w = ev.worker ? worker(ev.worker) : null;
    switch (ev.type) {
      case 'challenge.ingested':
        state.challenge.sourceType = ev.data.sourceType ?? null;
        state.challenge.sourceValue = ev.data.sourceValue ?? null;
        break;
      case 'master.triage':
        state.triage = ev.data;
        state.challenge.category = ev.data.category ?? state.challenge.category;
        state.challenge.flagFormat = ev.data.flagFormat?.regex ?? null;
        break;
      case 'worker.spawn':
        if (w) { w.persona = ev.data.persona ?? w.persona; w.spawnedAt = ev.t; }
        break;
      case 'worker.status':
        if (w) w.status = ev.data.status;
        break;
      case 'worker.progress':
        if (w) {
          w.steps = ev.data.steps ?? w.steps;
          w.tokensIn = ev.data.tokensIn ?? w.tokensIn;
          w.tokensOut = ev.data.tokensOut ?? w.tokensOut;
          w.seenAt = ev.t;
        }
        break;
      case 'worker.stalled':
        if (w) w.stallChecks = ev.data.checks ?? w.stallChecks + 1;
        break;
      case 'worker.tool':
        if (w) w.tools.push(ev.data);
        break;
      case 'worker.log':
        if (w) w.logs.push({ seq: ev.data.seq ?? 0, stream: ev.data.stream ?? 'transcript', text: ev.data.text ?? '' });
        break;
      case 'worker.diff':
        if (w) w.diff = ev.data.stats ?? null;
        break;
      case 'flag.found':
        state.flags.push({ workerId: ev.worker, ...ev.data });
        if (w && !w.flags.includes(ev.data.flag)) w.flags.push(ev.data.flag);
        break;
      case 'budget.capped':
        state.capNote = ev.data;
        break;
      case 'master.chat':
        state.masterChat.push({ direction: ev.data.direction ?? 'user', text: ev.data.text ?? '', actions: ev.data.actions ?? [], t: ev.t });
        break;
      case 'swarm.update':
        state.status = ev.data.status ?? state.status;
        if (ev.data.final) state.final = true;
        break;
      case 'swarm.stop':
        state.stoppedBy = ev.data.by ?? null;
        break;
      case 'admission.blocked':
        state.admission = ev.data;
        break;
      case 'swarm.postmortem':
        state.postmortem = ev.data.path ?? null;
        break;
      default:
        break;
    }
  }
  for (const w of workers.values()) {
    if (w.logs.length > 240) w.logs = w.logs.slice(-240);
    if (w.tools.length > 240) w.tools = w.tools.slice(-240);
  }
  state.eventCount = events.length;
  state.lastSeq = lastSeq;
  state.workers = [...workers.values()];
  state.workerIds = [...workers.keys()];
  return state;
}
