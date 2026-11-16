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
    strategy: 'Write pwntools/python/z3 solver scripts immediately; iterate on solver code rather than reading everything first. Prefer executable proof over theory.'
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
 * handleDirective: the chat surface's engine path. The master's tools are
 * orchestrator operations; every exchange emits master.chat events with the
 * actions that actually executed.
 */
export async function handleDirective({ provider, directive, ops, statusSnapshot }) {
  const res = await provider.chat({
    messages: [{
      role: 'user',
      content: [
        'You are the shingun master orchestrator. The operator typed a directive.',
        `Current swarm status: ${JSON.stringify(statusSnapshot)}`,
        `Directive: ${directive}`,
        'Act via tools: spawn_worker(persona, hint), prune_worker(workerId, reason), stop_swarm(reason), status_report(). Answer briefly in content after acting.'
      ].join('\n')
    }],
    tools: [
      { type: 'function', function: { name: 'spawn_worker', parameters: { type: 'object', properties: { persona: { type: 'string' }, hint: { type: 'string' } }, required: ['persona'] } } },
      { type: 'function', function: { name: 'prune_worker', parameters: { type: 'object', properties: { workerId: { type: 'string' }, reason: { type: 'string' } }, required: ['workerId'] } } },
      { type: 'function', function: { name: 'stop_swarm', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] } } },
      { type: 'function', function: { name: 'status_report', parameters: { type: 'object', properties: {}, required: [] } } }
    ],
    meta: { fixture: 'directive', key: 'directive', role: 'master' }
  });

  const actions = [];
  for (const call of res.message.tool_calls ?? []) {
    let args = {};
    try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { /* empty */ }
    switch (call.function?.name) {
      case 'spawn_worker': {
        const ok = await ops.spawnWorker(args.persona, args.hint);
        actions.push({ op: 'spawn_worker', persona: args.persona, ok });
        break;
      }
      case 'prune_worker': {
        const ok = await ops.pruneWorker(args.workerId, args.reason ?? 'operator directive');
        actions.push({ op: 'prune_worker', workerId: args.workerId, ok });
        break;
      }
      case 'stop_swarm': {
        await ops.stopSwarm(args.reason ?? 'operator directive');
        actions.push({ op: 'stop_swarm', ok: true });
        break;
      }
      case 'status_report': {
        const s = await ops.statusReport();
        actions.push({ op: 'status_report', summary: s });
        break;
      }
      default:
        actions.push({ op: call.function?.name ?? 'unknown', ok: false });
    }
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
