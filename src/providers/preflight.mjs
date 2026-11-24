import { resolveApiKey } from './registry.mjs';

/**
 * Role-provider preflight: the single check a launch path runs before any
 * provider call can happen. Shared by the HTTP launch route and the
 * console-scope create_swarm tool so both refuse identically.
 *
 * Returns null when the wiring is runnable, otherwise a
 * {code, message} pair for the caller to surface.
 */
export function preflightRoleProviders(config, env) {
  for (const roleName of ['master', 'worker']) {
    const provName = config.roles?.[roleName]?.provider;
    const prov = config.providers?.[provName];
    if (!prov || !provName) {
      return { code: 'provider_role_unconfigured', message: `role "${roleName}" has no provider — configure it in settings` };
    }
    if (prov.type === 'openai-compat') {
      const key = resolveApiKey(prov, env ?? {});
      if (typeof key === 'string' && /:\/\//.test(key)) {
        return {
          code: 'provider_key_invalid',
          message: `provider "${provName}" used by role "${roleName}" holds "${key.slice(0, 40)}…" — that is a web address, not an API key. Paste the model provider key in settings, or switch the role to the keyless mock provider.`
        };
      }
      if (!key) {
        return {
          code: 'provider_key_missing',
          message: `provider "${provName}" used by role "${roleName}" has no API key — paste one in settings, export the universal OPENAI_API_KEY, or switch the role to the keyless mock provider.`
        };
      }
    }
  }
  return null;
}
