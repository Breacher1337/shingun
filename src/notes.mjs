import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Shared findings: workers append {workerId, finding, tag} lines to
 * notes.jsonl via their shell (append-only by convention, fully audited via
 * worker.tool events); the master condenses them into ≤300-word digests
 * that are injected ONLY at spawn time. Live workers are never disturbed.
 */
export async function readNotes(notesPath) {
  let text = '';
  try { text = await fs.readFile(notesPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* tolerate malformed lines */ }
  }
  return out;
}

export function buildDigestInput(notes, deadStrategies = []) {
  const recent = notes.slice(-30);
  return {
    findings: recent.map((n) => ({ workerId: n.workerId, finding: n.finding, tag: n.tag })),
    deadEnds: deadStrategies.slice(-20)
  };
}

export function fallbackDigest(notes, deadStrategies = []) {
  const lines = notes.slice(-12).map((n) => `- (${n.workerId ?? '?'}) ${n.finding ?? ''}`.trim());
  const dead = deadStrategies.slice(-10).map((d) => `- dead end: ${typeof d === 'string' ? d : d.persona}`);
  return [
    'Findings from earlier siblings (verify before trusting):',
    ...(lines.length ? lines : ['- none yet']),
    ...(dead.length ? ['Strategies that already failed:'] : []),
    ...dead
  ].join('\n').slice(0, 3000);
}
