import { createOpenaiCompat } from './openai-compat.mjs';
import { createMock } from './mock.mjs';

/**
 * Role→provider resolution: roles map to a provider config entry; any
 * OpenAI-compatible endpoint, or the keyless mock, slots in by config.
 */
export function getProvider(config, roleName, { scrubber, logSink, fetchFn, env = {} } = {}) {
  const role = config.roles?.[roleName];
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
    const apiKey = env[prov.apiKeyEnv] ?? process.env[prov.apiKeyEnv] ?? '';
    return createOpenaiCompat({ ...prov, apiKey, fetchFn, ...shared });
  }
  if (prov.type === 'mock') {
    return createMock({ ...prov, ...shared });
  }
  throw Object.assign(new Error(`unknown provider type "${prov.type}"`), { code: 'provider_unknown_type' });
}
