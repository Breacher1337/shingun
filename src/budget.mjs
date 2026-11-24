/**
 * Budget guard: estimate-then-reconcile, and the ONLY gate in front of
 * provider calls. Pre-flight rejects calls that would blow a cap; post-flight
 * usage from the provider is authoritative.
 */
export function createBudgetGuard({ onCapped } = {}) {
  const scopes = new Map(); // scopeId -> { tokens, usd, tokenCap, usdCap }

  function ensure(scopeId, { tokenCap, usdCap } = {}) {
    if (!scopes.has(scopeId)) {
      scopes.set(scopeId, { tokens: 0, usd: 0, tokenCap: tokenCap ?? Infinity, usdCap: usdCap ?? Infinity });
    }
    return scopes.get(scopeId);
  }

  return {
    addScope(scopeId, caps) { ensure(scopeId, caps); },
    snapshot() {
      const out = {};
      for (const [id, s] of scopes) out[id] = { ...s };
      return out;
    },
    /**
     * Pre-flight: refuse a call whose estimate would cross any involved
     * scope's OWN caps. Scopes nest (worker ⊂ challenge ⊂ swarm) and each
     * keeps its own books; a scope's cap is checked against that scope's
     * spend plus the estimate — never against a sum across scopes, which
     * would count the same spend several times over (found live: workers
     * at ~18% of their cap were refused until the fix; test 4c-2).
     */
    preflight({ scopeIds = [], estTokens = 0, priceIn = 0, priceOut = 0, graceTokens = 0 }) {
      const scopeIdsAll = [...new Set(scopeIds)];
      const estUsd = (estTokens / 1e6) * (priceIn + priceOut) / 2;
      for (const id of scopeIdsAll) {
        const s = scopes.get(id);
        if (!s) continue;
        if (s.tokens + estTokens > s.tokenCap + graceTokens) {
          const capName = 'maxTokens';
          const scope = id.split(':')[0];
          onCapped?.(scope, capName, id);
          return { ok: false, scopeId: id, capName, scope };
        }
        if (s.usd + estUsd > s.usdCap) {
          const capName = 'usdCap';
          const scope = id.split(':')[0];
          onCapped?.(scope, capName, id);
          return { ok: false, scopeId: id, capName, scope };
        }
      }
      return { ok: true };
    },
    /** Post-flight reconcile: provider-reported usage is authoritative. */
    record({ scopeIds = [], tokensIn = 0, tokensOut = 0, priceIn = 0, priceOut = 0 }) {
      const usd = (tokensIn / 1e6) * priceIn + (tokensOut / 1e6) * priceOut;
      const crossed = [];
      for (const id of [...new Set(scopeIds)]) {
        const s = ensure(id);
        s.tokens += tokensIn + tokensOut;
        s.usd += usd;
        if (s.tokens > s.tokenCap || s.usd > s.usdCap) {
          crossed.push({ scopeId: id, capName: s.tokens > s.tokenCap ? 'maxTokens' : 'usdCap' });
        }
      }
      return { usd, crossed };
    }
  };
}
