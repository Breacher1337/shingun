import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace } from './helpers.mjs';

/**
 * Design language acceptance: the token layer and the live gallery are
 * served console routes, complete across all three themes, and covered by
 * the same access rules as every other static asset.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');

async function boot({ token = null } = {}) {
  const ws = await tmpWorkspace('style-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const merged = { ...env, ...(token ? { SHINGUN_TOKEN: token } : {}) };
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: merged, bus });
  const srv = await startServer({
    config, env: merged, orchestrator: orch, bus,
    workspaceDir: ws, webDir: path.join(ROOT, 'web'),
    envFile: path.join(ws, '.env'), configFile: path.join(ws, 'config.json')
  });
  await srv.listen(0);
  return { srv, ws, base: `http://127.0.0.1:${srv.server.address().port}`, token };
}

const THEMES = ['cocytus', 'albedo', 'demiurge'];
const STATUS_TOKENS = ['spawn', 'reasoning', 'tool', 'stall', 'solved', 'finish', 'dead'];

test('acceptance style: tokens.css serves complete across all three themes', async () => {
  const ctx = await boot();
  try {
    const res = await fetch(ctx.base + '/tokens.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/css/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const css = await res.text();

    // Every theme declares every status token — a theme ships complete.
    for (const theme of THEMES) {
      const section = css.split(`[data-theme="${theme}"]`)[1] ?? '';
      for (const st of STATUS_TOKENS) {
        assert.ok(
          new RegExp(`--status-${st}:\\s*#`).test(section),
          `theme "${theme}" declares --status-${st} as a concrete color`
        );
      }
    }
    // Albedo and demiurge are real [data-theme] overrides, not comments.
    assert.ok(css.includes('[data-theme="albedo"]') && css.includes('[data-theme="demiurge"]'));
    // The flagship wears teal; status hues stay untouched by brand changes.
    assert.ok(/--accent:\s*#0f766e;/.test(css));
    assert.match(css, /--status-reasoning:\s*#4da3ff;/);
    // Shared, theme-independent scales live exactly once in :root.
    assert.equal((css.match(/--sp-8:/g) ?? []).length, 1);
    assert.equal((css.match(/--fs-base:/g) ?? []).length, 1);
    // Feedback aliases indirect onto status hues; they carry no raw colors.
    assert.ok(css.includes('--danger: var(--status-dead);'));
    assert.ok(css.includes('--ok: var(--status-solved);'));
  } finally {
    await ctx.srv.close();
    fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance style: theme gallery is a live, switchable route', async () => {
  const ctx = await boot();
  try {
    const res = await fetch(ctx.base + '/theme-preview.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();

    // No attribute means cocytus: the page ships data-theme on <html>.
    assert.match(html, /<html[^>]*data-theme=/);
    // The gallery consumes the served token layer, not private styles.
    assert.ok(html.includes('href="/tokens.css"'));
    // A switcher button per theme, wired through the data attribute.
    for (const theme of THEMES) {
      assert.ok(html.includes(`data-set-theme="${theme}"`), `switch button for ${theme}`);
    }
    // Persistence matches the switching contract in STYLE-GUIDE.md.
    assert.ok(html.includes('shingun.theme'));
    assert.ok(html.includes('document.documentElement.dataset.theme'));
    // Semantic-token discipline: component styles reference tokens only.
    const styleBlock = html.split('<style>')[1]?.split('</style>')[0] ?? '';
    assert.ok(styleBlock.includes('var(--surface-'), 'gallery styles consume semantic tokens');
    assert.ok(!/--surface-\d:\s*#/.test(styleBlock), 'no raw hex assignments in gallery styles');
  } finally {
    await ctx.srv.close();
    fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
  }
});

test('acceptance style: the gallery obeys the same gate as the console', async () => {
  const ctx = await boot({ token: 't-' + 'b'.repeat(40) });
  try {
    const bare = await fetch(ctx.base + '/theme-preview.html');
    assert.equal(bare.status, 401, 'gated mode protects the gallery and tokens too');
    const bareCss = await fetch(ctx.base + '/tokens.css');
    assert.equal(bareCss.status, 401);
    const authed = await fetch(ctx.base + '/tokens.css', { headers: { Authorization: `Bearer ${ctx.token}` } });
    assert.equal(authed.status, 200);
  } finally {
    await ctx.srv.close();
    fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
  }
});
