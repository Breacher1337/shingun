import fs from 'node:fs/promises';
import path from 'node:path';
import { truncateBytes, listTree } from './util.mjs';

/** Persona seed catalog — distinct strategies, distinct prompts. */
export const PERSONA_CATALOG = {
  'static-analyst': {
    title: 'Static Analyst',
    strategy: 'Read everything before running anything. Map the codebase, identify the flag check, derive the answer by analysis. Prefer grep/read_file/sed over execution.'
  },
  'dynamic-fuzzer': {
    title: 'Dynamic Fuzzer',
    strategy: 'Run the challenge early and fuzz it: malformed inputs, edge cases, boundary values. Automate with short scripts; watch what breaks and iterate on crashes.'
  },
  'scripter': {
    title: 'Scripter / Exploit Engineer',
    strategy: 'Write pwntools/python/z3 solver scripts immediately; iterate on solver code rather than reading everything first. Prefer executable proof over theory.',
    lane: 'coder'
  },
  'crypto-algebraist': {
    title: 'Crypto Algebraist',
    strategy: 'Identify the primitive and its parameters first. Look for textbook weaknesses (ECB nonce reuse, weak PRNG, small modulus, lattice-reducible). Use sage/z3 where they pay.'
  },
  'web-recon': {
    title: 'Web Recon',
    strategy: 'Treat it as a service: enumerate routes, parameters, headers, source leaks. curl first, then targeted scripts; check for exposed backups and git dirs.'
  },
  'hypothesis-prover': {
    title: 'Hypothesis Prover',
    strategy: 'Start from the siblings\' dead ends (in your inherited context). Form one falsifiable hypothesis per step; each action must prove or kill it fast.'
  }
};

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/** Master triage: classify the challenge, infer the flag format, plan personas. */
export async function triage({ provider, repoSummary, knownFlagFormat, categoryHint }) {
  const prompt = [
    'You are the shingun master orchestrator triaging a CTF challenge repo.',
    '',
    'Files (top-level view):',
    repoSummary.topFiles.join('\n') || '(none listed)',
    '',
    'README excerpt:',
    (repoSummary.readmeExcerpt ?? '(no README)'),
    categoryHint ? `Operator category hint: ${categoryHint}` : '',
    knownFlagFormat ? `Declared flag format regex: ${knownFlagFormat}` : '',
    '',
    'Respond ONLY with JSON of shape:',
    '{"category":"crypto|web|pwn|rev|forensics|misc","flagFormat":"regex or null","confidence":"high|medium|low","workerCount":4,"personas":["static-analyst","scripter",...],"notes":"one line"}'
  ].filter(Boolean).join('\n');

  const res = await provider.chat({
    messages: [{ role: 'user', content: prompt }],
    meta: { fixture: 'triage', key: 'triage', role: 'master' }
  });
  const parsed = parseJsonLoose(res.message.content ?? '') ?? {};
  const personas = (parsed.personas ?? ['static-analyst', 'scripter', 'hypothesis-prover', 'web-recon'])
    .filter((p) => PERSONA_CATALOG[p]);
  const flagFormat = knownFlagFormat ?? parsed.flagFormat ?? null;
  return {
    category: parsed.category ?? 'misc',
    flagFormat,
    confidence: parsed.confidence ?? 'low',
    source: knownFlagFormat ? 'declared' : (flagFormat ? 'inferred' : 'unknown'),
    workerCount: Math.max(1, Number(parsed.workerCount) || 4),
    personas: personas.length ? personas : Object.keys(PERSONA_CATALOG).slice(0, 4),
    notes: parsed.notes ?? ''
  };
}

/** Digest ≤300 words of everything siblings learned, injected at spawn only. */
export async function buildDigest({ provider, digestInput, fallbackText }) {
  const res = await provider.chat({
    messages: [{
      role: 'user',
      content: `Condense these swarm findings and dead ends into at most 300 words of launch context for a new worker. JSON input:\n${JSON.stringify(digestInput)}`
    }],
    meta: { fixture: 'digest', key: 'digest', role: 'master' }
  });
  const text = (res.message.content ?? '').trim();
  return text || fallbackText || '(nothing yet)';
}

/** Respawn strategy: wide-not-deep, informed variant of the dead ends. */
export async function respawnVariant({ provider, deadStrategies, digestText }) {
  const res = await provider.chat({
    messages: [{
      role: 'user',
      content: `These swarm strategies failed: ${JSON.stringify(deadStrategies)}. Digest: ${digestText}. Respond ONLY with JSON {"persona":"<catalog key>","strategyPrompt":"<a NEW distinct strategy, not a retry of the dead ones>"}. Valid personas: ${Object.keys(PERSONA_CATALOG).join(', ')}.`
    }],
    meta: { fixture: 'respawn', key: 'respawn', role: 'master' }
  });
  const parsed = parseJsonLoose(res.message.content ?? '') ?? {};
  return {
    persona: PERSONA_CATALOG[parsed.persona] ? parsed.persona : 'hypothesis-prover',
    strategyPrompt: parsed.strategyPrompt ?? PERSONA_CATALOG['hypothesis-prover'].strategy
  };
}

/**
 * handleDirective: the cockpit's engine path. The master's tools are
 * orchestrator operations; every exchange emits master.chat events with the
 * actions that actually executed (or wait as pending confirm chips).
 * Scope decides the catalog: a bound swarm keeps the original four; the
 * console (no swarm bound) carries the full v2 catalog including node
 * lifecycle.
 */
export const SWARM_DIRECTIVE_TOOLS = [
  { type: 'function', function: { name: 'spawn_worker', description: 'Spawn one more worker in this swarm with a persona and an optional strategy hint.', parameters: { type: 'object', properties: { persona: { type: 'string' }, hint: { type: 'string' } }, required: ['persona'] } } },
  { type: 'function', function: { name: 'prune_worker', description: 'Stop a running worker by id.', parameters: { type: 'object', properties: { workerId: { type: 'string' }, reason: { type: 'string' } }, required: ['workerId'] } } },
  { type: 'function', function: { name: 'stop_swarm', description: 'Stop the swarm.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'status_report', description: 'Report the current swarm status summary.', parameters: { type: 'object', properties: {}, required: [] } } }
];

export const CONSOLE_DIRECTIVE_TOOLS = [
  ...SWARM_DIRECTIVE_TOOLS.map((t) => ({ type: 'function', function: { ...t.function } })),
  { type: 'function', function: { name: 'status_node', description: 'Read node-wide state: registered challenges and live swarms with their status and flag counts.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'create_challenge', description: 'Ingest a challenge from a local path or git url into the node workspace.', parameters: { type: 'object', properties: { source: { type: 'string', enum: ['path', 'url'] }, value: { type: 'string' }, flagFormatRegex: { type: 'string' }, categoryHint: { type: 'string' } }, required: ['source', 'value'] } } },
  { type: 'function', function: { name: 'create_swarm', description: 'Launch a swarm against a registered challenge. Absent challengeId targets the newest challenge this session created.', parameters: { type: 'object', properties: { challengeId: { type: 'string' }, workers: { type: 'number' }, budgetUsd: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'purge_swarm', description: 'Stop the swarm if live and clear its working artifacts (worktrees, scratch, tools). Review artifacts — events, transcripts, diffs, postmortems, bundles — survive. Absent swarmId targets the newest live swarm.', parameters: { type: 'object', properties: { swarmId: { type: 'string' }, force: { type: 'boolean' } }, required: [] } } },
  { type: 'function', function: { name: 'remove_challenge', description: 'Remove a challenge directory entirely. Absent challengeId targets the newest challenge this session created. Refused while any of its swarms is non-terminal.', parameters: { type: 'object', properties: { challengeId: { type: 'string' } }, required: [] } } }
];
// Console-scope ids are explicit: the original four gain their swarm argument.
for (const tool of CONSOLE_DIRECTIVE_TOOLS) {
  const f = tool.function;
  if (['spawn_worker', 'prune_worker', 'stop_swarm', 'status_report'].includes(f.name)) {
    const props = f.parameters.properties;
    props.swarmId = { type: 'string' };
    if (f.name !== 'status_report') {
      f.parameters.required = ['swarmId', ...f.parameters.required.filter((r) => r !== 'swarmId')];
    }
  }
}

export async function handleDirective({
  provider,
  directive,
  ops,
  statusSnapshot,
  tools = SWARM_DIRECTIVE_TOOLS,
  thread = [],
  preamble = 'You are the shingun master orchestrator. The operator typed a directive.',
  meta = { fixture: 'directive', key: 'directive', role: 'master' }
}) {
  const act = `Act via tools: ${tools.map((t) => `${t.function.name}(${Object.keys(t.function.parameters?.properties ?? {}).join(', ')})`).join(', ')}. Answer briefly in content after acting.`;
  const lines = [preamble];
  if (thread.length) {
    lines.push('', '## Console thread so far (continuity)', ...thread);
  }
  lines.push(`Current status: ${JSON.stringify(statusSnapshot)}`);
  lines.push(`Directive: ${directive}`);
  lines.push(act);
  const res = await provider.chat({
    messages: [{ role: 'user', content: lines.join('\n') }],
    tools,
    meta
  });

  const actions = [];
  for (const call of res.message.tool_calls ?? []) {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* empty */ }
    const op = call.function?.name;
    if (!ops[op]) {
      actions.push({ op, args, ok: false, detail: { code: 'unknown_tool' } });
      continue;
    }
    // gate: () => Promise<Action> when the caller guards directives
    // (undefined at engine level for direct execution). A thrown refusal
    // (swarms_active, bad_request, …) becomes a failed action the model
    // reads and can answer for — never a crashed directive.
    let out;
    try {
      out = ops[op].gate
        ? await ops[op].gate(args)
        : { op, ok: true, detail: await ops[op](args) };
    } catch (e) {
      out = { op, args, ok: false, detail: { code: e?.code ?? 'tool_failed', message: e?.message ?? String(e) } };
    }
    if (!out.op) out.op = op;
    actions.push(out);
  }
  return { reply: res.message.content ?? '', actions };
}

export async function readRepoSummary(baseDir) {
  const { fileCount, topFiles } = await listTree(baseDir);
  let readmeExcerpt = '(no README)';
  for (const name of ['README.md', 'readme.md', 'README', 'README.txt', 'README.rst']) {
    const p = path.join(baseDir, name);
    const text = await fs.readFile(p, 'utf8').catch(() => null);
    if (text) { readmeExcerpt = truncateBytes(text, 3500).text; break; }
  }
  return { fileCount, topFiles, readmeExcerpt };
}
