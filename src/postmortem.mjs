import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Post-mortem writer: plain markdown, written when a swarm ends
 * (solved/stopped/capped).
 */
export function renderPostmortem({ swarm, challenge, events, workers, flags, deadStrategies = [] }) {
  const attempts = workers.map((w) => {
    const status = w.lastStatus ?? 'finished';
    const key = String(w.keyFinding ?? '').replace(/\n/g, ' ').slice(0, 120);
    return '| ' + [w.id, w.persona, w.steps ?? 0, (w.tokensIn ?? 0) + '/' + (w.tokensOut ?? 0), status, key].join(' | ') + ' |';
  }).join('\n');

  const timeline = events
    .filter((e) => ['swarm.update', 'flag.found', 'worker.spawn', 'worker.pruned', 'budget.capped', 'admission.blocked'].includes(e.type))
    .slice(0, 30)
    .map((e) => '| ' + [e.t, e.type, e.worker ?? '-', JSON.stringify(e.data).slice(0, 140)].join(' | ') + ' |')
    .join('\n');

  const flagRows = flags.map((f) =>
    '| ' + [f.workerId, f.flag, f.formatMatch, String(f.reasoning ?? '').replace(/\n/g, ' ').slice(0, 160)].join(' | ') + ' |'
  ).join('\n');

  const dead = deadStrategies.length
    ? deadStrategies.map((d) => '- ' + d).join('\n')
    : 'None recorded.';

  const lines = [
    '# Post-mortem: swarm ' + swarm.id,
    '',
    '- **Challenge**: ' + challenge.id + ' (' + (challenge.sourceType ?? '?') + ': ' + (challenge.sourceValue ?? '?') + ')',
    '- **Category**: ' + (challenge.category ?? 'unknown') + ' · **Flag format**: ' + (challenge.flagFormat ?? 'unknown') + ' (' + (challenge.flagFormatSource ?? 'unknown') + ')',
    '- **Status**: ' + swarm.status + (swarm.solvedBy ? ' · solved by ' + swarm.solvedBy : ''),
    '',
    '## Flags',
    '',
    '| Worker | Flag | Format match | Reasoning |',
    '| --- | --- | --- | --- |',
    flagRows || '| - | - | - | - |',
    '',
    '## Attempts',
    '',
    '| Worker | Persona | Steps | Tokens in/out | Status | Key finding |',
    '| --- | --- | --- | --- | --- | --- |',
    attempts || '| - | - | - | - | - | - |',
    '',
    '## Timeline',
    '',
    '| Time | Event | Worker | Data |',
    '| --- | --- | --- | --- |',
    timeline || '| - | - | - | - |',
    '',
    '## Dead ends',
    '',
    dead,
    '',
    '## Artifacts',
    '',
    '- Transcripts: transcripts/ · Diffs: diffs/ · Shared notes: notes.jsonl',
    ''
  ];
  return lines.join('\n');
}

export async function writePostmortem({ challengeDir, swarmId, content }) {
  const dir = path.join(challengeDir, 'postmortems');
  await fs.mkdir(dir, { recursive: true });
  const { nowIso } = await import('./util.mjs');
  const out = path.join(dir, nowIso().slice(0, 10) + '-' + swarmId + '.md');
  await fs.writeFile(out, content, 'utf8');
  return out;
}
