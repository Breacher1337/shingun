import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  port: 8787,
  workspace: './workspace',
  profile: 'default',
  concurrency: { machineWorkers: 8, perChallengeWorkers: 6 },
  worker: {
    maxSteps: 40,
    maxTokens: 150000,
    wallClockMin: 30,
    commandTimeoutSec: 60,
    commandOutputCap: 10240,
    maxRespawnsPerChallenge: 12
  },
  stall: { checkIntervalSec: 90, checksToPrune: 2 },
  admission: { enabled: true, watermarkMb: 1536, meminfoPath: '/proc/meminfo', retryMs: 10000, fallbackFreemem: true },
  ingest: { maxExtractedBytes: 1024 * 1024 * 1024, maxExtractedEntries: 20000 },
  mcp: { maxFileBytes: 64 * 1024 * 1024 },
  tcp: { maxSessions: 16, maxBufferMb: 1, idleTtlMin: 5 },
  budget: { perSwarmUsd: 5.00 },
  roles: {
    // Safe-by-default: unconfigured runs use the keyless mock provider.
    // Point these at "mistral" (or any provider key) in config.json.
    master: { provider: 'mock', model: null },
    worker: { provider: 'mock', model: null },
    oracle: null,
    // Per-persona model lanes: a persona whose catalog entry names a lane
    // rides roles.lanes.<name> when configured, and the worker role otherwise.
    lanes: {}
  },
  providers: {
    callTimeoutMs: 120000,
    transcriptBodyBytes: 2048,
    mistral: {
      type: 'openai-compat',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKeyEnv: 'MISTRAL_API_KEY',
      defaultModel: 'mistral-large-latest',
      pricePerMTok: { in: 0.70, out: 2.10 }
    },
    mock: {
      type: 'mock',
      fixtureDir: './test/fixtures/mock',
      pricePerMTok: { in: 0.70, out: 2.10 }
    }
  },
  denylist: [
    'sudo', 'su ', 'rm -rf /', ' shutdown', ' reboot', 'mkfs',
    'dd if=/dev/zero of=/dev/', '/etc/shadow'
  ],
  git: { worktreeBranchPrefix: 'shingun/' },
  runner: { useSystemdScope: false, scopeMemoryMaxMb: 1024 },
  scrub: { envValuesFrom: './.env' }
};

const LOW_POWER = {
  concurrency: { machineWorkers: 4, perChallengeWorkers: 4 },
  worker: { commandTimeoutSec: 90, maxRespawnsPerChallenge: 8 }
};

const KNOWN_KEYS = new Set([
  'port', 'workspace', 'profile', 'concurrency', 'worker', 'stall',
  'admission', 'ingest', 'mcp', 'tcp', 'budget', 'roles', 'providers', 'denylist', 'git', 'runner', 'scrub'
]);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && base[k] && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function loadEnvFile(file) {
  const values = {};
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      values[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* absent .env is fine */ }
  return values;
}

export async function loadConfig({ file = './config.json', profile, envFile = './.env' } = {}) {
  let fileData = {};
  if (await fs.stat(file).then(() => true).catch(() => false)) {
    fileData = JSON.parse(await fs.readFile(file, 'utf8'));
    // Common hand-written shape: top-level master/worker/oracle objects
    // instead of the nested roles map. Fold them in instead of rejecting —
    // the operator's intent is unambiguous.
    const LEGACY_ROLES = ['master', 'worker', 'oracle'];
    const legacy = LEGACY_ROLES.filter((k) => k in fileData);
    if (legacy.length) {
      fileData.roles ?? (fileData.roles = {});
      for (const k of legacy) {
        if (fileData.roles[k] === undefined) {
          fileData.roles[k] = typeof fileData[k] === 'string' ? { provider: fileData[k] } : fileData[k];
        }
        delete fileData[k];
      }
    }
    for (const key of Object.keys(fileData)) {
      if (!KNOWN_KEYS.has(key)) {
        throw Object.assign(new Error(`config.json: unknown key "${key}"`), { code: 'config_invalid' });
      }
    }
  }
  let cfg = deepMerge(DEFAULT_CONFIG, fileData);
  const prof = profile ?? cfg.profile;
  if (prof === 'low-power') cfg = deepMerge(cfg, LOW_POWER);
  cfg.profile = prof;
  const env = await loadEnvFile(envFile);
  return { config: cfg, env };
}

/** Secret literal values eligible for egress scrubbing. */
export function envSecrets(env) {
  return Object.entries(env ?? {})
    .filter(([, v]) => typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v);
}

export function resolveWorkspace(config, override) {
  return path.resolve(override ?? config.workspace);
}
