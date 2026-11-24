import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './util.mjs';

/**
 * Console-scope cockpit thread: one append-only JSONL file per
 * workspace holding the master.chat lines of console-scope directives and
 * confirmations. Lines are the event envelope verbatim (`id` is
 * `console-<seq>`, monotonic); they publish to the bus after the store
 * write so the unscoped SSE stream re-emits exactly the stored bytes.
 *
 * The file is the whole truth: nothing is cached across restarts — replay
 * happens on demand per directive (continuity seed) — so a fresh serve on
 * the same workspace continues the thread where the last one left it.
 */

const lastSeq = (lines) => lines.reduce((n, l) => {
  const m = /-(\d+)$/.exec(String(l.id ?? ''));
  return Math.max(n, m ? Number(m[1]) : 0);
}, 0);

export function openConsoleStore({ dir, bus = null }) {
  const file = path.join(dir, 'console', 'chat.jsonl');
  let seq = 0;
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    seq = lastSeq(text.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return { id: '' }; }
    }));
  }

  return {
    file,
    /** Append one stored line; `data` is the master.chat payload. */
    async appendChat(data) {
      await ensureDir(path.dirname(file));
      seq += 1;
      const line = {
        v: 1,
        id: `console-${seq}`,
        t: new Date().toISOString(),
        type: 'master.chat',
        swarm: null,
        challenge: null,
        data
      };
      await fs.appendFile(file, JSON.stringify(line) + '\n', 'utf8');
      bus?.publish(line);
      return line;
    },
    /** Replay the whole thread; malformed tail lines are skipped. */
    async replay() {
      await load();
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      return text.split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    },
    /** Seed text for the master's continuity: last `cap` chat lines. */
    async seed(cap = 30) {
      const lines = await this.replay();
      return lines.slice(-cap).map((l) =>
        `${l.data.direction === 'user' ? 'operator' : 'master'}: ${l.data.text ?? ''}`
      );
    },
    /** Where per-console provider transcripts land (mock/test observability). */
    get logSink() { return path.join(dir, 'console', 'master.outbound.jsonl'); }
  };
}
