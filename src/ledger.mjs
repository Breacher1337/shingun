import { newId } from './util.mjs';

/**
 * Guard ledger: proposed master actions that merit confirmation
 * wait in a pending ledger as `{op, args, pending:true, actionId}` until
 * `POST /api/master/confirm {actionId}` executes exactly one of them.
 *
 * Matrix:
 *   reads (status_report, status_node)              — never gated
 *   purge_swarm                                      — gated in EVERY mode
 *   majors (default): create_challenge, create_swarm,
 *     remove_challenge, purge_swarm, stop_swarm      — gated
 *     (spawn_worker / prune_worker run instantly)
 *   all: every mutation, including spawn/prune       — gated
 *   instant: everything else                          — runs
 *
 * The ledger is server memory (#26–#27): a restart clears pending; a
 * newer in-scope directive, and the terminal transition of a target
 * swarm, supersede entries. Confirming superseded → 410 action_
 * superseded; unknown → 404 action_unknown.
 */

const READS = new Set(['status_report', 'status_node']);
const UNCONDITIONAL = new Set(['purge_swarm']);
const MAJORS = new Set(['create_challenge', 'create_swarm', 'remove_challenge', 'purge_swarm', 'stop_swarm']);
const MODES = ['instant', 'majors', 'all'];

function httpError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createGuardLedger({ config } = {}) {
  const defaultMode = config?.cockpit?.guard ?? 'majors';
  const pending = new Map(); // actionId -> entry
  const dead = new Map();     // actionId -> 'superseded' (bounded)

  function validateMode(mode) {
    if (mode === undefined || mode === null) return defaultMode;
    if (!MODES.includes(mode)) {
      throw httpError('bad_request', `guard must be one of ${MODES.join(' / ')}`);
    }
    return mode;
  }

  function needsGate(op, mode) {
    if (READS.has(op)) return false;
    if (UNCONDITIONAL.has(op)) return true;
    if (mode === 'all') return true; // every mutation
    if (mode === 'majors') return MAJORS.has(op);
    return false; // instant
  }

  async function run(entry) {
    try {
      const detail = await entry.execute();
      // Ops may refuse by returning {ok:false, detail}; refusals are
      // completed actions, not throws — the model reads them.
      if (detail && detail.ok === false) {
        return { op: entry.op, ok: false, detail: detail.detail ?? null };
      }
      return { op: entry.op, ok: true, detail: detail?.detail ?? detail ?? null };
    } catch (e) {
      return { op: entry.op, ok: false, detail: { code: e?.code ?? 'tool_failed', message: e?.message ?? String(e) } };
    }
  }

  function tombstone(id, reason) {
    dead.set(id, reason);
    while (dead.size > 1024) dead.delete(dead.keys().next().value);
  }

  return {
    get defaultMode() { return defaultMode; },
    validateMode,

    /**
     * One proposed action. Runs it now if unguarded, or parks it as a
     * `{pending:true, actionId}` chip for the operator. `execute` is the
     * deferred engine op; it is invoked at most once, either here or at
     * confirm time.
     */
    async gate({ op, args = {}, scope, swarm = null, mode, execute }) {
      const resolvedMode = validateMode(mode);
      const entry = { id: newId('ac'), op, args, scope, swarm, mode: resolvedMode, execute, t: new Date().toISOString() };
      if (!needsGate(op, resolvedMode)) {
        return run(entry);
      }
      pending.set(entry.id, entry);
      return { op, args, pending: true, actionId: entry.id };
    },

    /** Exactly one ledger entry, or a precise refusal. */
    async confirm(actionId, { mode } = {}) {
      const entry = pending.get(actionId);
      if (!entry) {
        if (dead.has(actionId)) {
          throw httpError('action_superseded', 'that action was superseded — ask the master again for a fresh proposal');
        }
        throw httpError('action_unknown', `no pending action ${actionId}`);
      }
      pending.delete(actionId);
      void mode;
      return { action: await run(entry), entry };
    },

    /** A newer in-scope directive supersedes same-scope pending entries. */
    expireForDirective({ scope, swarm = null }) {
      for (const [id, entry] of [...pending]) {
        const sameScope = entry.scope === scope;
        const sameSwarm = entry.swarm == null || swarm == null || entry.swarm === swarm;
        if (sameScope && sameSwarm) {
          pending.delete(id);
          tombstone(id, 'superseded by a newer directive');
        }
      }
    },

    /** A swarm's terminal transition supersedes entries targeting it. */
    expireSwarm(swarmId) {
      for (const [id, entry] of [...pending]) {
        if (entry.swarm === swarmId) {
          pending.delete(id);
          tombstone(id, 'superseded by a swarm-terminal transition');
        }
      }
    },

    /** Pending snapshot (read surface for #25's node route). */
    snapshot() {
      return [...pending.values()].map(({ id, op, args, scope, swarm, mode, t }) => ({
        actionId: id, op, args, scope, swarm, mode, t
      }));
    }
  };
}
