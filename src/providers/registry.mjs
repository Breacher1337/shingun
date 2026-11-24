import { createOpenaiCompat } from './openai-compat.mjs';
import { createMock } from './mock.mjs';

/**
 * API-key resolution, general OpenAI-compatible convention: the provider
 * entry's own env var (apiKeyEnv) wins; OPENAI_API_KEY — the universal
 * compat key every compatible endpoint honors — fills whenever the entry
 * declares no var or the var is unset. Switching provider stays a config
 * change, not an environment rename.
 */
export function resolveApiKey(prov, env = {}) {
  if (prov?.apiKeyEnv) {
    const specific = env[prov.apiKeyEnv] ?? process.env[prov.apiKeyEnv];
    if (specific) return specific;
  }
  return env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
}

/**
 * Role→provider resolution: roles map to a provider config entry; any
 * OpenAI-compatible endpoint, or the keyless mock, slots in by config.
 * A role name of the form "lanes:<name>" resolves a per-persona model lane
 * from roles.lanes.<name> instead — same shape, same rules.
 */
export function getProvider(config, roleName, { scrubber, logSink, fetchFn, env = {} } = {}) {
  const laneMatch = /^lanes:([\w-]+)$/.exec(roleName);
  const role = laneMatch ? config.roles?.lanes?.[laneMatch[1]] : config.roles?.[roleName];
  if (!role || !role.provider) {
    throw Object.assign(new Error(`role "${roleName}" is not configured`), { code: 'role_unconfigured' });
  }
  const prov = config.providers?.[role.provider];
  if (!prov) {
    throw Object.assign(new Error(`provider "${role.provider}" not found in config.providers`), { code: 'provider_unconfigured' });
  }
  const shared = {
    scrubber, logSink, modelOverride: role.model ?? null,
    price: prov.pricePerMTok ?? { in: 0.70, out: 2.10 },
    name: role.provider
  };
  if (prov.type === 'openai-compat') {
    const apiKey = resolveApiKey(prov, env);
    return createOpenaiCompat({ ...prov, apiKey, fetchFn, ...shared });
  }
  if (prov.type === 'mock') {
    return createMock({ ...prov, ...shared });
  }
  throw Object.assign(new Error(`unknown provider type "${prov.type}"`), { code: 'provider_unknown_type' });
}
