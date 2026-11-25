/**
 * Single per-swarm hard spend cap enforced in preflight.
 * No multi-scope ledgers or lane accounting — one invisible cap per swarm
 * as spend insurance.
 */
export function createBudgetGuard({ usdCap = Infinity, onCapped } = {}) {
  let usd = 0;
  let tokens = 0;

  return {
    preflight({ estTokens = 0, priceIn = 0, priceOut = 0 } = {}) {
      const estUsd = (estTokens / 1e6) * (priceIn + priceOut) / 2;
      if (usd + estUsd > usdCap) {
        const message = `swarm hard cap reached ($${usd.toFixed(4)} spent + $${estUsd.toFixed(4)} est > $${usdCap} cap)`;
        onCapped?.(message);
        return { ok: false, capName: 'usdCap', message };
      }
      return { ok: true };
    },
    record({ tokensIn = 0, tokensOut = 0, priceIn = 0, priceOut = 0 } = {}) {
      const callUsd = (tokensIn / 1e6) * priceIn + (tokensOut / 1e6) * priceOut;
      tokens += tokensIn + tokensOut;
      usd += callUsd;
      const crossed = usd > usdCap;
      return {
        usd: callUsd,
        crossed,
        message: crossed ? `swarm hard cap exceeded ($${usd.toFixed(4)} > $${usdCap} cap)` : null
      };
    },
    get spent() {
      return { usd, tokens };
    }
  };
}
