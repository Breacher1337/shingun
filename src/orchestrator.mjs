import fs from 'node:fs/promises';
import path from 'node:path';
import { openEventStore } from './store.mjs';
import { createBudgetGuard } from './budget.mjs';
import { admitWorker, sampleMemAvailable } from './admission.mjs';
import { makeJail } from './jail.mjs';
import { createLocalRunner } from './runner.mjs';
import { createScrubber } from './scrub.mjs';
import { getProvider } from './providers/registry.mjs';
import { addWorktree, captureDiff } from './worktree.mjs';
import { runWorker } from './worker.mjs';
import { PERSONA_CATALOG, triage as masterTriage, buildDigest, respawnVariant, handleDirective, readRepoSummary } from './master.mjs';
import { readNotes, buildDigestInput, fallbackDigest } from './notes.mjs';
import { renderPostmortem, writePostmortem } from './postmortem.mjs';
import { envSecrets } from './config.mjs';
import { newId, ensureDir } from './util.mjs';

/**
 * Swarm lifecycle: spawn (admission-gated), stall monitoring, prune +
 * wide-not-deep respawn, solved path with sibling stop, and deterministic
 * crash resume by replaying the event store. One orchestrator instance
 * covers ALL swarms in the process; machine-wide worker accounting is
 * shared across challenges.
 */
export function createOrchestrator({ config, workspaceDir, env = {}, bus, memSample = sampleMemAvailable }) {
  const scrubber = createScrubber(envSecrets(env));
  const runner = createLocalRunner({ config });
  const guard = createBudgetGuard({ onCapped: () => {} });
  const swarms = new Map(); // swarmId → runtime state

  const challengesDir = path.join(workspaceDir, 'challenges');
  const activeWorkerCount = () =>
    [...swarms.values()].reduce((n, s) => n + [...s.workers.values()].filter((w) => w.live).length, 0);

  function getProviderFor(role, { logSink } = {}) {
    return getProvider(config, role, { scrubber, env, logSink });
  }

  const personaFallbackStrategy = (key) => (PERSONA_CATALOG[key] ?? PERSONA_CATALOG['static-analyst']).strategy;

  const syncStub = (id, tag) => ({
    id, persona: `(${tag})`, steps: 0, tokensIn: 0, tokensOut: 0,
    lastProgressAt: Date.now(), stallChecks: 0, lastStatus: 'spawning', live: true,
    keyFinding: null, cancel: false, steerQueue: [], isReservation: true
  });

  async function startSwarm({ challenge, opts = {} }) {
    const swarmId = newId('sw');
    const cid = challenge.id;
    const chDir = path.join(challengesDir, cid);
    const eventsFile = path.join(chDir, 'events', `${swarmId}.jsonl`);
    await ensureDir(path.dirname(eventsFile));
    const store = await openEventStore(eventsFile, { swarmId });
    guard.addScope(`challenge:${cid}`, { usdCap: opts.budgetUsd ?? config.budget.perChallengeUsd });
    guard.addScope(`swarm:${swarmId}`, { usdCap: opts.budgetUsd ?? config.budget.perSwarmUsd });

    const s = {
      id: swarmId,
      challengeId: cid,
      challenge,
      chDir,
      store,
      status: 'planning',
      workers: new Map(),
      flags: [],
      respawns: 0,
      deadStrategies: [],
      cancelled: false,
      solvedBy: null,
      stallTimer: null
    };
    swarms.set(swarmId, s);
    s.done = new Promise((resolve) => { s.doneResolve = resolve; });

    const emit = async (type, data, extra = {}) => {
      // store-first, then the bus publishes the stored bytes
      const full = await store.append({ type, swarm: swarmId, challenge: cid, data, ...extra });
      bus?.publish(full);
      return full;
    };
    s.emit = emit;

    // 1. Triage.
    const masterProvider = getProviderFor('master', { logSink: path.join(chDir, 'transcripts', 'master.outbound.jsonl') });
    await emit('challenge.ingested', {
      sourceType: challenge.sourceType, sourceValue: challenge.sourceValue,
      fileCount: challenge.fileCount, topFiles: challenge.topFiles, category: challenge.categoryHint
    });
    const summary = await readRepoSummary(challenge.baseDir);
    const plan = await masterTriage({
      provider: masterProvider,
      repoSummary: summary,
      knownFlagFormat: challenge.flagFormatRegex,
      categoryHint: challenge.categoryHint
    });
    await emit('master.triage', {
      category: plan.category,
      flagFormat: { regex: plan.flagFormat, confidence: plan.confidence, source: plan.source },
      workerCount: plan.workerCount, personas: plan.personas
    });

    const challengeFlag = challenge.flagFormatRegex ?? plan.flagFormat;
    Object.assign(challenge, { category: plan.category, flagFormat: challengeFlag, flagFormatSource: plan.source });

    // 2. Spawn wave, admission-gated.
    const perChallenge = Math.min(opts.workers ?? plan.workerCount, config.concurrency.perChallengeWorkers);
    s.status = 'running';
    await emit('swarm.update', { status: 'running' });

    const spawnPromises = [];
    for (let i = 0; i < perChallenge; i++) {
      const persona = plan.personas[i % plan.personas.length];
      spawnPromises.push(spawnSwarmWorker(s, {
        persona, strategyPrompt: PERSONA_CATALOG[persona].strategy,
        digestText: fallbackDigest([], []), masterProvider, challengeFlag
      }).catch((e) => emit('worker.status', { status: 'finished', reason: `spawn_error: ${e.message}` }, { worker: 'unknown' })));
    }
    Promise.allSettled(spawnPromises).then(() => maybeCloseSwarm(s, emit));

    // 3. Stall checker timer.
    s.stallTimer = setInterval(() => stallCheck(s, emit), Math.max(5, config.stall.checkIntervalSec) * 1000);
    s.stallTimer.unref?.();

    return { swarmId, emit };
  }

  async function spawnSwarmWorker(s, { persona, strategyPrompt, digestText, masterProvider, challengeFlag, workerIdHint }) {
    const wid = workerIdHint ?? newId('w');
    const dirs = {
      worktree: path.join(s.chDir, 'worktrees', wid),
      scratch: path.join(s.chDir, 'scratch', wid),
      tools: path.join(s.chDir, 'tools'),
      notes: path.join(s.chDir, 'notes.jsonl'),
      transcript: path.join(s.chDir, 'transcripts', `${wid}.jsonl`)
    };
    void masterProvider;

    const emit = s.emit;

    // Admission gate: blocked spawns retry until the swarm stops.
    for (;;) {
      if (s.cancelled) return { outcome: 'stopped-before-spawn' };
      const adm = await admitWorker({ config, activeWorkers: activeWorkerCount(), sample: memSample });
      if (adm.ok) break;
      await emit('admission.blocked', {
        memAvailableMb: adm.memAvailableMb, watermarkMb: adm.watermarkMb ?? config.admission.watermarkMb,
        intendingPersona: persona, reason: adm.reason
      }, { worker: wid });
      await new Promise((r) => setTimeout(r, config.admission.retryMs ?? 10000));
    }

    const w = {
      id: wid, persona, steps: 0, tokensIn: 0, tokensOut: 0,
      lastProgressAt: Date.now(), stallChecks: 0, lastStatus: 'spawning', live: true,
      keyFinding: null, cancel: false, steerQueue: []
    };
    s.workers.set(wid, w);

    await addWorktree({ baseDir: s.challenge.baseDir, worktreesDir: path.join(s.chDir, 'worktrees'), workerId: wid, branchPrefix: config.git.worktreeBranchPrefix });
    await ensureDir(dirs.scratch);
    const jail = await makeJail([dirs.worktree, dirs.scratch, dirs.tools, dirs.notes, s.challenge.baseDir]);

    const result = await runWorker({
      workerId: wid, swarmId: s.id, challengeId: s.challengeId,
      persona, strategyPrompt, digestText, flagFormat: challengeFlag,
      dirs,
      provider: getProviderFor('worker', { logSink: path.join(s.chDir, 'transcripts', `${wid}.outbound.jsonl`) }),
      budgetGuard: guard, config,
      emit: async (type, data) => {
        if (type === 'worker.progress') {
          w.steps = data.steps; w.tokensIn = data.tokensIn; w.tokensOut = data.tokensOut;
          w.lastProgressAt = data.seenAt ?? Date.now(); w.stallChecks = 0;
        }
        if (type === 'worker.status') { w.lastStatus = data.status; }
        if (type === 'worker.log' && data.stream === 'transcript') { w.keyFinding = data.text?.slice(0, 300); }
        await emit(type, data, { worker: wid });
      },
      steer: { drain: () => { const out = w.steerQueue; w.steerQueue = []; return out; } },
      isCancelled: () => s.cancelled || w.cancel,
      hooks: {
        jail, runner,
        submitFlag: (args) => validateAndAccept(s, emit, wid, args, challengeFlag),
        finish: (args) => { w.keyFinding = JSON.stringify(args.summary ?? {}).slice(0, 300); return { ok: true }; }
      }
    });

    w.live = false;

    // Capture the diff once the worker stops moving (review trail).
    const cap = await captureDiff(dirs.worktree).catch(() => ({ stats: { files: 0, insertions: 0, deletions: 0 }, diff: '' }));
    await fs.mkdir(path.join(s.chDir, 'diffs'), { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(s.chDir, 'diffs', `${wid}.diff`), cap.diff, 'utf8').catch(() => {});
    await emit('worker.diff', { stats: cap.stats, capturedAt: new Date().toISOString() }, { worker: wid });

    if (result.outcome === 'solved' && !s.solvedBy) {
      s.solvedBy = wid;
    }
    w.closed = true; // fully settled: loop done, diff captured, events flushed
    return result;
  }

  async function validateAndAccept(s, emit, wid, args, flagRegex) {
    const flag = String(args.flag ?? '');
    let formatMatch = 'unknown';
    if (flagRegex) {
      try {
        formatMatch = new RegExp(flagRegex).test(flag) ? 'match' : 'mismatch';
      } catch { formatMatch = 'unknown'; }
    }
    if (s.flags.some((f) => f.flag === flag)) {
      return { accepted: true, formatMatch, duplicate: true };
    }
    s.flags.push({ workerId: wid, flag, formatMatch, reasoning: args.reasoning ?? '' });
    await emit('flag.found', { workerId: wid, flag, formatMatch, reasoning: args.reasoning ?? '' }, { worker: wid });
    // Accepted regardless of match: validation is advisory; a human decides.
    await solvedPath(s, emit, wid);
    return { accepted: true, formatMatch };
  }

  async function solvedPath(s, emit, solvedWid) {
    if (s.status === 'solved') return; // first flag wins
    s.status = 'solved';
    s.solvedBy = solvedWid;
    await emit('swarm.update', { status: 'solved', solvedBy: solvedWid });
    await emit('swarm.stop', { by: 'solved' });
    await stopWorkers(s, emit, 'swarm solved');
    await finishSwarm(s, emit);
  }

  async function stopWorkers(s, emit, reason) {
    s.cancelled = true;
    for (const w of s.workers.values()) {
      if (w.live) {
        w.cancel = true;
        await emit('worker.status', { status: 'finished', reason }, { worker: w.id });
        w.lastStatus = 'finished';
        w.live = false;
      }
    }
  }

  async function stallCheck(s, emit) {
    if (s.cancelled || s.status !== 'running') return;
    const now = Date.now();
    for (const w of s.workers.values()) {
      if (!w.live) continue;
      if (now - w.lastProgressAt > config.stall.checkIntervalSec * 1000) {
        w.stallChecks += 1;
        await emit('worker.stalled', { checks: w.stallChecks }, { worker: w.id });
        if (w.stallChecks >= config.stall.checksToPrune) {
          await pruneWorker(s, emit, w.id, 'stalled');
        }
      } else {
        w.stallChecks = 0;
        w.lastProgressAt = w.lastProgressAt ?? now;
      }
    }
    maybeCloseSwarm(s, emit, true);
  }

  async function pruneWorker(s, emit, wid, reason) {
    const w = s.workers.get(wid);
    if (!w || !w.live) return false;
    const personaKey = w.persona;
    w.cancel = true;
    w.live = false;
    w.lastStatus = 'pruned';
    await emit('worker.status', { status: 'pruned', reason }, { worker: wid });
    w.lastProgressAt = Date.now(); // stop double-pruning
    await emit('worker.pruned', { reason, persona: personaKey }, { worker: wid });

    if (personaKey && !s.deadStrategies.some((d) => d.persona === personaKey)) {
      s.deadStrategies.push({ persona: personaKey, note: reason });
    }

    // Wide-not-deep respawn: a new strategy plus an informed variant of
    // the dead one; both count against the respawn quota.
    if (s.respawns + 2 <= config.worker.maxRespawnsPerChallenge && !s.cancelled) {
      s.respawns += 2;
      const wid2 = newId('w');
      const wid3 = newId('w');
      s.workers.set(wid2, syncStub(wid2, 'respawn-new'));
      s.workers.set(wid3, syncStub(wid3, 'respawn-variant'));
      const masterProvider = getProviderFor('master');
      const notes = await readNotes(path.join(s.chDir, 'notes.jsonl')).catch(() => []);
      const dead = s.deadStrategies.map((d) => `${d.persona}: ${d.note}`);
      const digestText = await buildDigest({
        provider: masterProvider,
        digestInput: buildDigestInput(notes, dead),
        fallbackText: fallbackDigest(notes, dead)
      }).catch(() => fallbackDigest(notes, dead));
      const rep = await respawnVariant({ provider: masterProvider, deadStrategies: s.deadStrategies.map((d) => d.persona), digestText }).catch(() => ({ persona: 'hypothesis-prover', strategyPrompt: PERSONA_CATALOG['hypothesis-prover'].strategy }));
      const spawn = (spawnOpts) => spawnSwarmWorker(s, { ...spawnOpts, digestText, challengeFlag: s.challenge.flagFormat })
        .then((r) => { maybeCloseSwarm(s, emit); return r; });
      spawn({ persona: rep.persona, strategyPrompt: rep.strategyPrompt, workerIdHint: wid2, masterProvider }).catch(() => {});
      const variantBase = PERSONA_CATALOG[personaKey] ?? PERSONA_CATALOG['static-analyst'];
      spawn({
        persona: personaKey,
        strategyPrompt: `${variantBase.strategy}\nVariant twist informed by earlier failure "${reason}": ${rep.strategyPrompt}`,
        workerIdHint: wid3, masterProvider
      }).catch(() => {});
    }
    return true;
  }

  function maybeCloseSwarm(s, emit, soft = false) {
    if (s.status !== 'running') return;
    const live = [...s.workers.values()].some((w) => w.live);
    if (live) return;
    s.status = s.solvedBy ? 'solved' : (s.cancelled ? 'stopped' : 'capped');
    if (soft) return;
    finishSwarm(s, emit).catch(() => {});
  }

  async function finishSwarm(s, emit) {
    if (s.stallTimer) clearInterval(s.stallTimer);
    if (s.status !== 'solved') {
      s.status = s.cancelled ? 'stopped' : (s.flags.length ? 'solved' : 'capped');
      await emit('swarm.update', { status: s.status });
    }
    const events = await s.store.replay();
    const content = renderPostmortem({
      swarm: {
        id: s.id, status: s.status, solvedBy: s.solvedBy,
        spentTokens: guard.snapshot()?.[`swarm:${s.id}`]?.tokens ?? 0,
        spentUsd: guard.snapshot()?.[`swarm:${s.id}`]?.usd ?? 0
      },
      challenge: {
        id: s.challengeId, sourceType: s.challenge.sourceType, sourceValue: s.challenge.sourceValue,
        category: s.challenge.category, flagFormat: s.challenge.flagFormat, flagFormatSource: s.challenge.flagFormatSource
      },
      events,
      workers: [...s.workers.values()].map((w) => ({ ...w })),
      flags: s.flags,
      deadStrategies: s.deadStrategies.map((d) => `${d.persona}: ${d.note}`)
    });
    const out = await writePostmortem({ challengeDir: s.chDir, swarmId: s.id, content });
    await emit('swarm.postmortem', { path: out });
    await emit('swarm.update', { status: s.status, final: true });
    s.doneResolve?.(s.status);
  }

  async function stopSwarm(s, emit, by = 'user') {
    if (s.status === 'solved' || s.status === 'stopped') return;
    await emit('swarm.stop', { by: 'user' });
    await stopWorkers(s, emit, `swarm stopped (${by})`);
    s.status = 'stopped';
    await finishSwarm(s, emit);
  }

  function statusSummary(swarmId) {
    const s = swarms.get(swarmId);
    if (!s) return null;
    const snap = guard.snapshot();
    return {
      swarmId: s.id, challengeId: s.challengeId, status: s.status,
      solvedBy: s.solvedBy, respawns: s.respawns,
      budget: {
        swarmTokens: snap[`swarm:${s.id}`]?.tokens ?? 0,
        swarmUsd: snap[`swarm:${s.id}`]?.usd ?? 0
      },
      flags: s.flags,
      workers: [...s.workers.values()].map((w) => ({
        id: w.id, persona: w.persona, status: w.lastStatus, steps: w.steps,
        tokensIn: w.tokensIn, tokensOut: w.tokensOut, live: w.live
      }))
    };
  }

  /** Directive cockpit: the master manipulates the running swarm. */
  async function directive(swarmId, text) {
    const s = swarms.get(swarmId);
    if (!s) throw Object.assign(new Error(`unknown swarm ${swarmId}`), { code: 'swarm_unknown' });
    if (['solved', 'stopped'].includes(s.status)) {
      return { reply: 'Swarm is already terminal.', actions: [] };
    }
    const emit = s.emit;
    await emit('master.chat', { direction: 'user', text });
    const masterProvider = getProviderFor('master');
    const out = await handleDirective({
      provider: masterProvider,
      directive: text,
      statusSnapshot: statusSummary(swarmId),
      ops: {
        spawnWorker: async (persona, hint) => {
          if (!(persona && PERSONA_CATALOG[persona])) persona = 'hypothesis-prover';
          const wid = newId('w');
          s.workers.set(wid, syncStub(wid, 'directive'));
          const notes = await readNotes(path.join(s.chDir, 'notes.jsonl')).catch(() => []);
          spawnSwarmWorker(s, {
            persona, strategyPrompt: hint ?? personaFallbackStrategy(persona),
            digestText: fallbackDigest(notes, s.deadStrategies.map((d) => `${d.persona}: ${d.note}`)),
            masterProvider, challengeFlag: s.challenge.flagFormat, workerIdHint: wid
          }).then(() => maybeCloseSwarm(s, emit)).catch(() => {});
          return true;
        },
        pruneWorker: async (pwid, reason) => pruneWorker(s, emit, pwid, reason ?? 'directive'),
        stopSwarm: async (reason) => { await stopSwarm(s, emit, reason ?? 'directive'); return true; },
        statusReport: async () => statusSummary(swarmId)
      }
    });
    await emit('master.chat', { direction: 'master', text: out.reply, actions: out.actions });
    return out;
  }

  async function steerWorker(swarmId, workerId, text) {
    const s = swarms.get(swarmId);
    const w = s?.workers.get(workerId);
    if (!s || !w) throw Object.assign(new Error('unknown worker'), { code: 'worker_unknown' });
    w.steerQueue.push(text);
    return { queued: true };
  }

  /** Resume: replay swarms whose store says running/planning. */
  async function resume() {
    const resumed = [];
    const chDirs = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
    for (const d of chDirs) {
      if (!d.isDirectory()) continue;
      const evDir = path.join(challengesDir, d.name, 'events');
      const files = await fs.readdir(evDir).catch(() => []);
      for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
        const swarmId = f.replace(/\.jsonl$/, '');
        if (swarms.has(swarmId)) continue;
        const store = await openEventStore(path.join(evDir, f), { swarmId });
        const events = await store.replay();
        if (!events.length) continue;
        const lastStatus = [...events].reverse().find((e) => e.type === 'swarm.update')?.data?.final
          ? null
          : ([...events].reverse().find((e) => e.type === 'swarm.update')?.data?.status ?? 'planning');
        if (!['running', 'planning'].includes(lastStatus)) continue;

        // Rebuild: flags, per-worker state, usage totals.
        const flags = events.filter((e) => e.type === 'flag.found').map((e) => ({ ...e.data, workerId: e.worker }));
        const perWorker = new Map();
        for (const e of events) {
          if (!e.worker) continue;
          if (!perWorker.has(e.worker)) {
            perWorker.set(e.worker, syncStub(e.worker, 'resumed'));
          }
          const w = perWorker.get(e.worker);
          if (e.type === 'worker.spawn') { w.persona = e.data.persona; }
          if (e.type === 'worker.status') {
            const terminal = ['pruned', 'capped', 'solved', 'finished'].includes(e.data.status);
            w.lastStatus = terminal ? e.data.status : 'resumed-unfinished';
            // Reconstructed workers are HISTORY, not processes: they must not
            // count toward the admission cap, or respawns block forever.
            w.unfinished = !terminal;
            w.live = false;
          }
          if (e.type === 'worker.progress') { w.steps = e.data.steps; w.tokensIn = e.data.tokensIn; w.tokensOut = e.data.tokensOut; }
        }

        const chDir = path.dirname(evDir);
        const cid = d.name; // challenges/<challengeId>/events/<swarmId>.jsonl
        const sourceMatch = events.find((e) => e.type === 'challenge.ingested')?.data;
        const triageEv = events.find((e) => e.type === 'master.triage')?.data;
        const challenge = {
          id: cid,
          sourceType: sourceMatch?.sourceType ?? 'path',
          sourceValue: sourceMatch?.sourceValue ?? '(resumed)',
          baseDir: path.join(chDir, 'base'),
          category: triageEv?.category,
          flagFormat: triageEv?.flagFormat?.regex ?? null,
          flagFormatSource: triageEv?.flagFormat?.source ?? 'unknown'
        };

        const s = {
          id: swarmId, challengeId: cid, challenge, chDir, store,
          status: 'running', workers: new Map(perWorker), flags,
          respawns: 0,
          deadStrategies: events.filter((e) => e.type === 'worker.pruned').map((e) => ({ persona: e.data.persona ?? 'unknown', note: e.data.reason ?? '' })),
          cancelled: false, solvedBy: null, stallTimer: null
        };
        swarms.set(swarmId, s);
        const emit = async (type, data, extra = {}) => {
          const full = await store.append({ type, swarm: swarmId, challenge: cid, data, ...extra });
          bus?.publish(full);
          return full;
        };
        s.emit = emit;

        if (flags.length) {
          s.status = 'solved';
          s.solvedBy = flags[0].workerId;
          for (const w of s.workers.values()) { w.live = false; }
          await emit('swarm.update', { status: 'solved', resumed: true });
        } else {
          await emit('swarm.update', { status: 'running', resumed: true });
          // Fresh respawn of unfinished workers, informed by the digest.
          // Uses the `unfinished` marker (not `live`) so history doesn't
          // consume the admission budget meant for real respawned workers.
          const uniqUnfinished = [...new Set(events
            .filter((e) => e.type === 'worker.status' && ['reasoning', 'toolcall', 'spawning'].includes(e.data.status))
            .map((e) => e.worker))];
          const notes = await readNotes(path.join(chDir, 'notes.jsonl')).catch(() => []);
          const digestText = fallbackDigest(notes, s.deadStrategies.map((x) => `${x.persona}: ${x.note}`));
          const masterProvider = getProviderFor('master');
          const respawnIds = uniqUnfinished.length
            ? uniqUnfinished.slice(0, config.concurrency.perChallengeWorkers)
            : [null];
          for (const oldWid of respawnIds) {
            const old = oldWid ? perWorker.get(oldWid) : null;
            const persona = PERSONA_CATALOG[old?.persona] ? old.persona : 'hypothesis-prover';
            const wid = newId('w');
            syncStub(wid, 'resume');
            const stub = syncStub(wid, 'resume');
            s.workers.set(wid, stub);
            spawnSwarmWorker(s, {
              persona,
              strategyPrompt: PERSONA_CATALOG[persona].strategy,
              digestText, masterProvider, challengeFlag: challenge.flagFormat, workerIdHint: wid
            }).then(() => maybeCloseSwarm(s, emit)).catch(() => {});
          }
          s.stallTimer = setInterval(() => stallCheck(s, emit), Math.max(5, config.stall.checkIntervalSec) * 1000);
          s.stallTimer.unref?.();
        }
        resumed.push(swarmId);
      }
    }
    return resumed;
  }

  async function stop(swarmId, by = 'user') {
    const s = swarms.get(swarmId);
    if (!s) throw Object.assign(new Error(`unknown swarm ${swarmId}`), { code: 'swarm_unknown' });
    await stopSwarm(s, s.emit, by);
  }

  return {
    startSwarm, resume, stop, steerWorker, directive, statusSummary,
    activeWorkerCount, guard, swarms,
    emitAll: () => [...swarms.keys()]
  };
}
