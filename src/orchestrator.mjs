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
import { PERSONA_CATALOG, triage as masterTriage, buildDigest, respawnVariant, handleDirective, readRepoSummary, CONSOLE_DIRECTIVE_TOOLS } from './master.mjs';
import { openConsoleStore } from './console.mjs';
import { preflightRoleProviders } from './providers/preflight.mjs';
import { readNotes, buildDigestInput, fallbackDigest } from './notes.mjs';
import { renderPostmortem, writePostmortem } from './postmortem.mjs';
import { envSecrets } from './config.mjs';
import { ingestChallenge, validateTarget } from './ingest.mjs';
import { newId, ensureDir, writeJson, listTree } from './util.mjs';

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
  const swarms = new Map(); // swarmId → runtime state

  const challengesDir = path.join(workspaceDir, 'challenges');
  const activeWorkerCount = () =>
    [...swarms.values()].reduce((n, s) => n + [...s.workers.values()].filter((w) => w.live).length, 0);

  function getProviderFor(role, { logSink } = {}) {
    return getProvider(config, role, { scrubber, env, logSink });
  }

  function meterMasterProvider(inner, { capGuard = null, emit, scope } = {}) {
    const price = inner.price ?? { in: 0.70, out: 2.10 };
    return {
      ...inner,
      async chat(callOpts) {
        if (capGuard) {
          const estTokens = Math.ceil((callOpts?.messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);
          const pre = capGuard.preflight({ estTokens, priceIn: price.in, priceOut: price.out });
          if (!pre.ok) {
            await emit('budget.capped', { scope: 'swarm', capName: pre.capName, role: 'master', reason: pre.message });
            throw Object.assign(new Error(pre.message), { code: 'budget_capped' });
          }
        }
        const res = await inner.chat(callOpts);
        const tin = res.usage?.tokensIn ?? 0;
        const tout = res.usage?.tokensOut ?? 0;
        let costUsd;
        if (capGuard) {
          const rec = capGuard.record({ tokensIn: tin, tokensOut: tout, priceIn: price.in, priceOut: price.out });
          costUsd = rec.usd;
          if (rec.crossed) {
            await emit('budget.capped', { scope: 'swarm', capName: 'usdCap', role: 'master', reason: rec.message });
          }
        } else {
          costUsd = (tin / 1e6) * price.in + (tout / 1e6) * price.out;
        }
        await emit('usage.tick', {
          role: 'master',
          ...(scope ? { scope } : {}),
          provider: inner.name ?? 'unknown',
          tokensIn: tin,
          tokensOut: tout,
          costUsd
        });
        return res;
      }
    };
  }

  /**
   * Worker provider resolution with per-persona model lanes: a persona whose
   * catalog entry names a lane rides roles.lanes.<name> when that lane is
   * configured; everyone else rides the plain worker role. Returns
   * { lane, providerFor(logSink) } so spawn sites stay one call.
   */
  function getWorkerLane(persona) {
    const lane = PERSONA_CATALOG[persona]?.lane;
    return lane && config.roles?.lanes?.[lane]?.provider
      ? { lane, role: `lanes:${lane}` }
      : { lane: null, role: 'worker' };
  }

  const personaFallbackStrategy = (key) => (PERSONA_CATALOG[key] ?? PERSONA_CATALOG['static-analyst']).strategy;

  /** Challenge basename from its source value — the mock lane's fixture slug. */
  function sourceSlug(sourceValue) {
    const raw = String(sourceValue ?? '').replace(/[\\/]+$/, '');
    let base = raw.split(/[\\/]/).pop() ?? '';
    if (/\.git$/i.test(base)) base = base.slice(0, -4);
    return /^[\w.-]{1,64}$/.test(base) ? base : null;
  }

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
    const capGuard = createBudgetGuard({ usdCap: opts.budgetUsd ?? config.budget.perSwarmUsd });

    const s = {
      id: swarmId,
      challengeId: cid,
      challenge,
      chDir,
      store,
      capGuard,
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
    const masterProvider = meterMasterProvider(
      getProviderFor('master', { logSink: path.join(chDir, 'transcripts', 'master.outbound.jsonl') }),
      { capGuard: s.capGuard, emit }
    );
    await emit('challenge.ingested', {
      sourceType: challenge.sourceType, sourceValue: challenge.sourceValue,
      fileCount: challenge.fileCount, topFiles: challenge.topFiles, category: challenge.categoryHint,
      ...(challenge.target ? { target: challenge.target } : {})
    });
    const summary = await readRepoSummary(challenge.baseDir);
    const plan = await masterTriage({
      provider: masterProvider,
      repoSummary: summary,
      knownFlagFormat: challenge.flagFormatRegex,
      categoryHint: challenge.categoryHint,
      target: challenge.target ?? null
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
        digestText: fallbackDigest([], []), masterProvider, challengeFlag,
        challengeTarget: s.challenge.target ?? null
      }).catch((e) => emit('worker.status', { status: 'finished', reason: `spawn_error: ${e.message}` }, { worker: 'unknown' })));
    }
    Promise.allSettled(spawnPromises).then(() => maybeCloseSwarm(s, emit));

    // 3. Stall checker timer.
    s.stallTimer = setInterval(() => stallCheck(s, emit), Math.max(5, config.stall.checkIntervalSec) * 1000);
    s.stallTimer.unref?.();

    return { swarmId, emit };
  }

  async function spawnSwarmWorker(s, { persona, strategyPrompt, digestText, masterProvider, challengeFlag, challengeTarget = null, workerIdHint }) {
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
      // Unref'd: an unadmittable machine must not hold the process (and the
      // test runner) past the swarm's terminal state purely on retry timing.
      await new Promise((r) => { const t = setTimeout(r, config.admission.retryMs ?? 10000); t.unref?.(); });
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

    const workerLane = getWorkerLane(persona);
    const result = await runWorker({
      workerId: wid, swarmId: s.id, challengeId: s.challengeId,
      challengeSlug: sourceSlug(s.challenge.sourceValue),
      persona, strategyPrompt, digestText, flagFormat: challengeFlag, target: challengeTarget,
      dirs,
      lane: workerLane.lane,
      provider: getProviderFor(workerLane.role, { logSink: path.join(s.chDir, 'transcripts', `${wid}.outbound.jsonl`) }),
      budgetGuard: s.capGuard, config,
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
      const masterProvider = meterMasterProvider(getProviderFor('master'), { capGuard: s.capGuard, emit: s.emit });
      const notes = await readNotes(path.join(s.chDir, 'notes.jsonl')).catch(() => []);
      const dead = s.deadStrategies.map((d) => `${d.persona}: ${d.note}`);
      const digestText = await buildDigest({
        provider: masterProvider,
        digestInput: buildDigestInput(notes, dead),
        fallbackText: fallbackDigest(notes, dead)
      }).catch(() => fallbackDigest(notes, dead));
      const rep = await respawnVariant({ provider: masterProvider, deadStrategies: s.deadStrategies.map((d) => d.persona), digestText }).catch(() => ({ persona: 'hypothesis-prover', strategyPrompt: PERSONA_CATALOG['hypothesis-prover'].strategy }));
      const spawn = (spawnOpts) => spawnSwarmWorker(s, { ...spawnOpts, digestText, challengeFlag: s.challenge.flagFormat, challengeTarget: s.challenge.target ?? null })
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
        id: s.id, status: s.status, solvedBy: s.solvedBy
      },
      challenge: {
        id: s.challengeId, sourceType: s.challenge.sourceType, sourceValue: s.challenge.sourceValue,
        category: s.challenge.category, flagFormat: s.challenge.flagFormat, flagFormatSource: s.challenge.flagFormatSource,
        target: s.challenge.target?.url ?? null
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
    return {
      swarmId: s.id, challengeId: s.challengeId, status: s.status,
      solvedBy: s.solvedBy, respawns: s.respawns,
      flags: s.flags,
      workers: [...s.workers.values()].map((w) => ({
        id: w.id, persona: w.persona, status: w.lastStatus, steps: w.steps,
        tokensIn: w.tokensIn, tokensOut: w.tokensOut, live: w.live
      }))
    };
  }

  /** Directive cockpit: the master manipulates the running swarm. Guarded
   * executions arrive as a `gate` (server-side ledger); without one the ops
   * execute directly — engine-level tests drive it this way. */
  async function directive(swarmId, text, opts = {}) {
    const s = swarms.get(swarmId);
    if (!s) throw Object.assign(new Error(`unknown swarm ${swarmId}`), { code: 'swarm_unknown' });
    const emit = s.emit;
    if (['solved', 'stopped'].includes(s.status)) {
      // Terminal swarms still answer: the exchange persists to the deck so a
      // relayed directive never vanishes from the operator's chat history.
      const reply = 'Swarm is already terminal.';
      await emit('master.chat', { direction: 'user', text, scope: 'sw' });
      await emit('master.chat', { direction: 'master', text: reply, actions: [] });
      return { reply, actions: [] };
    }
    await emit('master.chat', { direction: 'user', text, scope: 'sw' });
    const masterProvider = meterMasterProvider(getProviderFor('master'), { capGuard: s.capGuard, emit });
    const rawOps = {
      spawn_worker: async (args) => {
        const persona = args.persona && PERSONA_CATALOG[args.persona] ? args.persona : 'hypothesis-prover';
        const wid = newId('w');
        s.workers.set(wid, syncStub(wid, 'directive'));
        const notes = await readNotes(path.join(s.chDir, 'notes.jsonl')).catch(() => []);
        spawnSwarmWorker(s, {
          persona, strategyPrompt: args.hint ?? personaFallbackStrategy(persona),
          digestText: fallbackDigest(notes, s.deadStrategies.map((d) => `${d.persona}: ${d.note}`)),
          masterProvider, challengeFlag: s.challenge.flagFormat, challengeTarget: s.challenge.target ?? null, workerIdHint: wid
        }).then(() => maybeCloseSwarm(s, emit)).catch(() => {});
        return { spawned: wid, persona };
      },
      prune_worker: async (args) => {
        const ok = await pruneWorker(s, emit, args.workerId, args.reason ?? 'directive');
        return ok === false ? { ok: false, detail: { workerId: args.workerId } } : true;
      },
      stop_swarm: async (args) => {
        await stopSwarm(s, emit, args.reason ?? 'directive');
        return true;
      },
      status_report: async () => statusSummary(swarmId)
    };
    const ops = {};
    for (const [op, fn] of Object.entries(rawOps)) {
      ops[op] = opts.gate
        ? { gate: (args) => opts.gate({ op, args, scope: 'sw', swarm: swarmId, execute: () => fn(args) }) }
        : fn;
    }
    const out = await handleDirective({
      provider: masterProvider,
      directive: text,
      statusSnapshot: statusSummary(swarmId),
      ops,
      meta: opts.meta
    });
    await emit('master.chat', { direction: 'master', text: out.reply, scope: 'sw', actions: out.actions });
    return out;
  }

  // -- console scope ------------------------------------------------------

  let consoleStore = null;
  const getConsoleStore = () => (consoleStore ?? (consoleStore = openConsoleStore({ dir: workspaceDir, bus: bus ?? null })));

  const TERMINAL_SWARM_STATUSES = ['solved', 'stopped', 'capped'];
  let lastChallengeId = null;
  let lastSwarmId = null;

  function engineError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  /** Challenge registration, shared by console create_challenge, HTTP ingest, and MCP. */
  async function createChallenge({ source, value, title, hint, flagFormatRegex, categoryHint, target, maxBytes, challengeId } = {}) {
    const safeTarget = validateTarget(target);
    if (!source && safeTarget) {
      source = 'none'; // pure live-web/tcp challenge: the target is the challenge
    }
    const allowed = ['url', 'path', 'download', 'upload', 'none'];
    if (!allowed.includes(source)) {
      throw engineError('bad_request', 'source must be "url" (git), "path" (folder/file), "download" (archive/file URL), or "upload" — or pass a target');
    }
    if (source !== 'none' && source !== 'upload' && (typeof value !== 'string' || !value.trim())) {
      throw engineError('bad_request', 'value must be a non-empty string');
    }
    await ensureDir(challengesDir);
    const ing = await ingestChallenge({
      source,
      value: source === 'none' ? '' : source === 'upload' ? value : value.trim(),
      challengesDir,
      challengeId,
      target: safeTarget,
      maxBytes,
      maxExtractedBytes: config.ingest?.maxExtractedBytes,
      maxExtractedEntries: config.ingest?.maxExtractedEntries
    });
    const chDir = path.join(challengesDir, ing.challengeId);
    await writeJson(path.join(chDir, 'challenge.json'), {
      challengeId: ing.challengeId,
      sourceType: source,
      sourceValue: source === 'upload' ? (value?.filename || 'upload.bin') : source === 'none' ? '' : value.trim(),
      title: typeof title === 'string' ? title.slice(0, 120) : null,
      hint: typeof hint === 'string' ? hint.slice(0, 500) : null,
      target: ing.target ?? null,
      flagFormatRegex: typeof flagFormatRegex === 'string' ? flagFormatRegex : null,
      categoryHint: typeof categoryHint === 'string' ? categoryHint : null,
      ingestedAt: new Date().toISOString(),
      fileCount: ing.fileCount,
      topFiles: ing.topFiles
    });
    lastChallengeId = ing.challengeId;
    return { challengeId: ing.challengeId, fileCount: ing.fileCount, topFiles: ing.topFiles, target: ing.target ?? null };
  }

  /** Launch a swarm on a registered challenge (console create_swarm). */
  async function createSwarm({ challengeId, workers, budgetUsd } = {}) {
    const providerIssue = preflightRoleProviders(config, env);
    if (providerIssue) throw engineError(providerIssue.code, providerIssue.message);
    const cid = challengeId ?? lastChallengeId;
    if (!cid) {
      throw engineError('bad_request', 'create_swarm: no challenge registered in this session yet — call create_challenge first or pass challengeId');
    }
    const chDir = path.join(challengesDir, cid);
    const meta = await fs.readFile(path.join(chDir, 'challenge.json'), 'utf8')
      .then((t) => JSON.parse(t))
      .catch(() => null);
    if (!meta) throw engineError('challenge_unknown', `challenge not registered under this node: ${cid}`);
    let workerCount;
    if (workers !== undefined) {
      workerCount = Number(workers);
      if (!Number.isInteger(workerCount) || workerCount < 1) {
        throw engineError('bad_request', 'workers must be a positive integer');
      }
      workerCount = Math.min(workerCount, config.concurrency.perChallengeWorkers);
    }
    let budget;
    if (budgetUsd !== undefined) {
      budget = Number(budgetUsd);
      if (!Number.isFinite(budget) || budget <= 0) {
        throw engineError('bad_request', 'budgetUsd must be a positive number');
      }
      budget = Math.min(budget, config.budget.perSwarmUsd);
    }
    const { fileCount, topFiles } = await listTree(path.join(chDir, 'base')).catch(() => ({ fileCount: 0, topFiles: [] }));
    const { swarmId } = await startSwarm({
      challenge: {
        id: cid,
        sourceType: meta.sourceType,
        sourceValue: meta.sourceValue,
        baseDir: path.join(chDir, 'base'),
        fileCount,
        topFiles,
        title: meta.title ?? null,
        hint: meta.hint ?? null,
        target: meta.target ?? null,
        flagFormatRegex: meta.flagFormatRegex,
        categoryHint: meta.categoryHint
      },
      opts: { workers: workerCount, budgetUsd: budget }
    });
    lastSwarmId = swarmId;
    return { swarmId };
  }

  /** Console purge: stop if live, clear working artifacts, KEEP review
   * artifacts. */
  async function purgeSwarm({ swarmId } = {}) {
    const sid = swarmId ?? lastSwarmId;
    if (!sid) throw engineError('bad_request', 'purge_swarm: no swarm this session to target — pass swarmId');
    const s = swarms.get(sid);
    if (s && !TERMINAL_SWARM_STATUSES.includes(s.status)) {
      await stopSwarm(s, s.emit, 'purged (operator confirm)');
      for (let i = 0; i < 200; i++) {
        const settled = [...s.workers.values()].every((w) => w.closed || w.isReservation);
        if (settled) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const chDir = s ? s.chDir : await locateChallengeForSwarm(sid);
    if (!chDir) throw engineError('swarm_unknown', `unknown swarm ${sid}`);
    for (const dirName of ['worktrees', 'scratch', 'tools']) {
      await fs.rm(path.join(chDir, dirName), { recursive: true, force: true }).catch(() => {});
    }
    return { swarmId: sid, kept: ['events', 'transcripts', 'diffs', 'postmortems', 'bundles'] };
  }

  async function locateChallengeForSwarm(swarmId) {
    if (!/^[\w-]+$/.test(swarmId ?? '')) return null;
    const entries = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const storeFile = path.join(challengesDir, entry.name, 'events', `${swarmId}.jsonl`);
      const exists = await fs.stat(storeFile).then(() => true).catch(() => false);
      if (exists) return path.join(challengesDir, entry.name);
    }
    return null;
  }

  /** Console remove: whole directory, refused while any swarm is non-terminal. */
  async function removeChallenge({ challengeId } = {}) {
    const cid = challengeId ?? lastChallengeId;
    if (!cid) {
      throw engineError('bad_request', 'remove_challenge: no challenge registered in this session yet — pass challengeId or call create_challenge first');
    }
    const chDir = path.join(challengesDir, cid);
    const exists = await fs.stat(chDir).then(() => true).catch(() => false);
    if (!exists) throw engineError('challenge_unknown', `challenge not registered under this node: ${cid}`);
    for (const [sid, s] of swarms) {
      if (s.challengeId === cid && !TERMINAL_SWARM_STATUSES.includes(s.status)) {
        throw engineError('swarms_active', `challenge ${cid} still has a live swarm (${sid}) — purge or stop it first`);
      }
    }
    const eventFiles = await fs.readdir(path.join(chDir, 'events')).catch(() => []);
    for (const f of eventFiles.filter((x) => x.endsWith('.jsonl') && x !== 'mcp.jsonl')) {
      const store = await openEventStore(path.join(chDir, 'events', f), { swarmId: f.replace(/\.jsonl$/, '') });
      const events = await store.replay();
      const lastUpdate = [...events].reverse().find((e) => e.type === 'swarm.update');
      const terminal = lastUpdate?.data?.final ?? TERMINAL_SWARM_STATUSES.includes(lastUpdate?.data?.status ?? '');
      if (events.length && !terminal) {
        throw engineError('swarms_active', `challenge ${cid} has swarm ${f.replace(/\.jsonl$/, '')} that never reached terminal state`);
      }
    }
    await fs.rm(chDir, { recursive: true, force: true }).catch(() => {});
    if (lastChallengeId === cid) lastChallengeId = null;
    return { challengeId: cid, removed: true };
  }

  /** Node-wide read for the console master: challenges on disk + live swarms. */
  async function statusNode() {
    const dirs = await fs.readdir(challengesDir, { withFileTypes: true }).catch(() => []);
    const challengeIds = dirs.filter((d) => d.isDirectory()).map((d) => d.name);
    const liveSwarms = [...swarms.values()].map((s) => ({
      swarmId: s.id, challengeId: s.challengeId, status: s.status, flags: s.flags.length
    }));
    return { challenges: { count: challengeIds.length, ids: challengeIds }, liveSwarms, newestChallenge: lastChallengeId, newestSwarm: lastSwarmId };
  }

  /** Route a console master-chat line (also used by confirm receipts, #28). */
  async function appendConsoleChat(data) {
    return getConsoleStore().appendChat(data);
  }

  /** Record a guard-confirmed execution into its thread. */
  async function recordExecuted({ entry, action }) {
    const executed = {
      op: action.op,
      ok: action.ok,
      ...(action.detail !== null && action.detail !== undefined ? { detail: action.detail } : {})
    };
    const text = `confirmed: ${entry.op}`;
    if (entry.scope === 'console') {
      return getConsoleStore().appendChat({ direction: 'master', text, scope: 'console', actions: [executed] });
    }
    const s = swarms.get(entry.swarm);
    if (s) return s.emit('master.chat', { direction: 'master', text, scope: 'sw', actions: [executed] });
    return null;
  }

  /** Console-scope directive: thread continuity from the store. */
  async function directiveConsole({ text, gate, meta }) {
    const store = getConsoleStore();
    const thread = await store.seed(30);
    await store.appendChat({ direction: 'user', text, scope: 'console' });
    const usageStore = await openEventStore(path.join(workspaceDir, 'console', 'usage.jsonl'), { swarmId: 'console' });
    const masterProvider = meterMasterProvider(getProviderFor('master', { logSink: store.logSink }), {
      scope: 'console',
      emit: async (type, data) => {
        const ev = await usageStore.append({ type, swarm: null, challenge: null, data });
        bus?.publish(ev);
        return ev;
      }
    });
    const rawOps = {
      status_node: async () => ({ ...(await statusNode()) }),
      create_challenge: async (args) => createChallenge(args),
      create_swarm: async (args) => {
        const out = await createSwarm(args);
        return { swarmId: out.swarmId, challengeId: args.challengeId ?? lastChallengeId };
      },
      purge_swarm: async (args) => purgeSwarm(args),
      remove_challenge: async (args) => removeChallenge(args),
      spawn_worker: async (args) => {
        const s = swarms.get(args.swarmId);
        if (!s) throw engineError('swarm_unknown', `unknown swarm ${args.swarmId}`);
        const sub = await directive(args.swarmId, text, { gate, meta });
        return sub.actions[0] ?? { ok: false, detail: { code: 'delegate' } };
      },
      prune_worker: async (args) => {
        const s = swarms.get(args.swarmId);
        if (!s) throw engineError('swarm_unknown', `unknown swarm ${args.swarmId}`);
        const ok = await pruneWorker(s, s.emit, args.workerId, args.reason ?? 'console directive');
        return ok === false ? { ok: false, detail: { workerId: args.workerId } } : true;
      },
      stop_swarm: async (args) => {
        const sid = args.swarmId ?? lastSwarmId;
        const s = swarms.get(sid);
        if (!s) throw engineError('swarm_unknown', `unknown swarm ${sid}`);
        await stopSwarm(s, s.emit, args.reason ?? 'console directive');
        return true;
      },
      status_report: async (args) => {
        const sid = args.swarmId ?? lastSwarmId;
        const s = swarms.get(sid);
        if (!s) throw engineError('swarm_unknown', `unknown swarm ${sid}`);
        return statusSummary(sid);
      }
    };
    const ops = {};
    for (const [op, fn] of Object.entries(rawOps)) {
      ops[op] = gate
        ? { gate: (args) => gate({ op, args, scope: 'console', swarm: args?.swarmId ?? null, execute: () => fn(args) }) }
        : fn;
    }
    const out = await handleDirective({
      provider: masterProvider,
      directive: text,
      statusSnapshot: await statusNode(),
      tools: CONSOLE_DIRECTIVE_TOOLS,
      thread,
      preamble: 'You are the shingun master orchestrator on console duty — no single swarm is bound; the operator drives the whole node from this console. Prefer explicit ids when known.',
      ops,
      meta: meta ?? { fixture: 'console-directive', key: 'console', role: 'master' }
    });
    await store.appendChat({ direction: 'master', text: out.reply, scope: 'console', actions: out.actions });
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
      for (const f of files.filter((x) => x.endsWith('.jsonl') && x !== 'mcp.jsonl')) {
        const swarmId = f.replace(/\.jsonl$/, '');
        if (swarms.has(swarmId)) continue;
        const store = await openEventStore(path.join(evDir, f), { swarmId });
        const events = await store.replay();
        if (!events.length) continue;
        const lastStatus = [...events].reverse().find((e) => e.type === 'swarm.update')?.data?.final
          ? null
          : ([...events].reverse().find((e) => e.type === 'swarm.update')?.data?.status ?? 'planning');
        if (!['running', 'planning'].includes(lastStatus)) continue;

        // A "planning" store with no worker ever spawned is a launch that
        // died inside triage — nothing to resume. Mark it final rather than
        // resurrecting phantom workers from a swarm that never started.
        if (lastStatus === 'planning' && !events.some((e) => e.type === 'worker.spawn')) {
          const ev = await store.append({
            type: 'swarm.update', swarm: swarmId, challenge: d.name,
            data: { status: 'stopped', final: true, reason: 'resume: launch never started' }
          });
          bus?.publish(ev);
          continue;
        }

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
          title: null, hint: null, target: sourceMatch?.target ?? null,
          category: triageEv?.category,
          flagFormat: triageEv?.flagFormat?.regex ?? null,
          flagFormatSource: triageEv?.flagFormat?.source ?? 'unknown'
        };

        const workerProvName = config.roles?.worker?.provider;
        const fallbackPrice = config.providers?.[workerProvName]?.pricePerMTok ?? { in: 0.70, out: 2.10 };
        let seededUsd = 0;
        let seededTokens = 0;
        for (const e of events) {
          if (e.type !== 'usage.tick') continue;
          const tin = Number(e.data?.tokensIn) || 0;
          const tout = Number(e.data?.tokensOut) || 0;
          const provName = e.data?.provider;
          const price = config.providers?.[provName]?.pricePerMTok ?? fallbackPrice;
          seededUsd += (tin / 1e6) * (price.in ?? 0) + (tout / 1e6) * (price.out ?? 0);
          seededTokens += tin + tout;
        }

        const s = {
          id: swarmId, challengeId: cid, challenge, chDir, store,
          capGuard: createBudgetGuard({
            usdCap: config.budget.perSwarmUsd,
            initialUsd: seededUsd,
            initialTokens: seededTokens
          }),
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
        await emit('budget.resumed', { usd: seededUsd, tokens: seededTokens });

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
          const masterProvider = meterMasterProvider(getProviderFor('master'), { capGuard: s.capGuard, emit: s.emit });
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
              digestText, masterProvider, challengeFlag: challenge.flagFormat, challengeTarget: challenge.target ?? null, workerIdHint: wid
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
    startSwarm, resume, stop, steerWorker, directive, directiveConsole,
    createChallenge, createSwarm, purgeSwarm, removeChallenge, statusNode,
    appendConsoleChat, recordExecuted, getConsoleStore, statusSummary,
    activeWorkerCount, swarms,
    emitAll: () => [...swarms.keys()]
  };
}
