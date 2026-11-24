import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import timers from 'node:timers';
import { loadConfig, resolveWorkspace } from '../src/config.mjs';
import { createBus } from '../src/bus.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { startServer } from '../src/server.mjs';
import { tmpWorkspace } from './helpers.mjs';
import { installDomShim } from './dom-shim.mjs';
import { createLabServer } from '../examples/sqli-lab/app.mjs';

/**
 * Dashboard acceptance: web/dashboard.mjs — the actual page code, unmodified —
 * boots inside a DOM shim and is exercised click by click against a real
 * engine+server. Nothing here mocks the engine, the routes or the store.
 *
 * The happy path covered: launch modal → ingest the bundled sqli-lab →
 * swarm spawns → workers run real UNION-injection curls → flag surfaces in
 * the trophy strip → bundle export over HTTP → steer box → settings key and
 * role switching, including the "pasted a URL as an API key" refusal that
 * must never, ever take the workspace down again.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_CONFIG = path.join(ROOT, 'test', 'fixtures', 'test-config.json');
const EXPECTED_FLAG = 'shingun{un10n_s3l3ct_pwn3d_th3_sh0p}';

const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

async function waitFor(fn, timeoutMs, everyMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const out = await Promise.resolve().then(() => fn()).catch(() => null);
    if (out) return out;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

async function boot() {
  const ws = await tmpWorkspace('dash-');
  const { config, env } = await loadConfig({ file: TEST_CONFIG, profile: 'low-power' });
  const bus = createBus();
  const orch = createOrchestrator({ config, workspaceDir: resolveWorkspace(config, ws), env: { ...env }, bus });
  const srv = await startServer({
    config, env: { ...env }, orchestrator: orch, bus,
    workspaceDir: ws,
    webDir: path.join(ROOT, 'web'),
    envFile: path.join(ws, '.env'),
    configFile: path.join(ws, 'config.json')
  });
  await srv.listen(0);
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  return { srv, orch, bus, ws, base };
}

async function teardown(ctx) {
  for (const [id] of ctx.orch.swarms) {
    await ctx.orch.stop(id, 'test-teardown').catch(() => {});
  }
  await Promise.all([...ctx.orch.swarms.values()].map((s) =>
    (typeof s.done?.then === 'function' ? s.done : Promise.resolve()).catch(() => {})));
  for (const s of ctx.orch.swarms.values()) {
    for (let i = 0; i < 200; i++) {
      const settled = [...s.workers.values()].every((w) => w.closed || w.isReservation);
      if (settled) break;
      await sleep(25);
    }
  }
  await ctx.srv.close();
  fs.rm(ctx.ws, { recursive: true, force: true }).catch(() => {});
}

test('acceptance 4a: dashboard page boots, launches the sqli-lab swarm, records the real injection, and shows the flag', async () => {
  const ctx = await boot();
  let lab = null;
  try {
    // The bundled mock-lane solver attacks the lab on its fixed port.
    lab = await createLabServer({ port: 9377 }).catch(() => null);

    const shim = installDomShim({ baseUrl: ctx.base });
    const { document, fetchLog } = shim;
    assert.equal((await fetch(ctx.base + '/')).status, 200, 'server up and open');
    await import(pathToFileURL(path.join(ROOT, 'web', 'dashboard.mjs')).href);

    // -- the shell is wired: interactive elements have handlers -----------
    const tbNew = document.querySelector('#tb-new');
    assert.ok(tbNew, 'topbar renders');
    assert.equal(typeof tbNew.onclick, 'function', '+ challenge button clickable');
    assert.equal(typeof document.querySelector('#tb-settings').onclick, 'function');
    assert.equal(typeof document.querySelector('#tb-flags').onclick, 'function');
    const deckInput = document.querySelector('#deck-input');
    assert.ok(deckInput, 'command deck renders');
    assert.equal(deckInput.disabled, true, 'deck waits for a swarm');

    // -- launch modal: prefill, category, cloud count ----------------------
    tbNew.onclick();
    assert.ok(document.querySelector('#nl-value'), 'launch modal opens');
    assert.equal(document.querySelector('#nl-value').value, 'examples/sqli-lab', 'demo lab prefilled');
    document.querySelector('#nl-workers').value = '2';

    document.querySelector('#nl-go').click();
    const connected = await waitFor(() => {
      const t = document.querySelector('#deck-swarm-label')?.textContent;
      return t && t.startsWith('sw-') ? t : null;
    }, 60000);
    assert.ok(connected, 'swarm launched and dashboard connected');
    assert.equal((await waitFor(() => document.querySelectorAll('.tile').length >= 2 ? 2 : null, 30000)), 2,
      'worker tiles render');

    // -- workers visibly attack the lab while the swarm lives --------------
    assert.equal(document.querySelector('#tb-stop').style.display, '', 'stop button live while running');

    // -- solve: flag lands in the trophy strip ------------------------------
    const solved = await waitFor(() =>
      document.querySelector('#tb-flags .flagcount')?.textContent === '1' ? true : null, 120000);
    assert.ok(solved, 'swarm solved through the mock SQLi lane');
    const tiles = document.querySelectorAll('.last-tool').map((e) => e.textContent).join('\n');
    assert.ok(tiles.includes('UNION SELECT'), 'a worker really ran the union injection: ' + tiles.slice(0, 200));
    assert.equal(document.querySelector('#tb-stop').style.display, 'none', 'stop retired once terminal');
    assert.equal(document.querySelector('#tb-export').style.display, '', 'bundle offered on solve');

    // -- trophy room ---------------------------------------------------------
    document.querySelector('#tb-flags').click();
    const lit = await waitFor(() => document.querySelector('.flag-lit'), 5000);
    assert.ok(lit.textContent.includes(EXPECTED_FLAG), 'trophy shows the mock CTF flag: ' + lit.textContent);
    const sub = document.querySelector('.flag-sub').textContent;
    const workerId = /via (w-[\w-]+)/.exec(sub)?.[1];
    assert.ok(workerId, 'flag attributed to a worker: ' + sub);

    // -- inspector steer box -------------------------------------------------
    const tile = document.querySelectorAll('.tile').find((t) => {
      const wid = t.querySelector('.wid');
      return wid && wid.textContent === workerId;
    });
    assert.ok(tile, 'solving worker tile found');
    tile.click();
    const steerInput = await waitFor(() => document.querySelector('#ins-steer'), 5000);
    assert.ok(steerInput, 'steer box renders in the inspector');
    steerInput.value = 'verify the flag row over curl one more time';
    document.querySelector('#ins-steer-send').click();
    assert.ok(await waitFor(() =>
      document.querySelectorAll('.toast').some((t) => t.textContent.includes('steering note queued')), 5000),
    'steer route accepted');

    // -- browser-driven bundle export ---------------------------------------
    document.querySelector('#tb-export').click();
    assert.ok(await waitFor(() =>
      fetchLog.some((u) => u.includes('/bundle')), 15000), 'bundle fetch issued from the page');
    assert.ok(await waitFor(() =>
      document.querySelectorAll('.toast').some((t) => t.textContent.includes('review bundle downloading')), 5000),
    'bundle download confirmed');

    // -- settings: role picker, key validation, role switching ---------------
    document.querySelector('#tb-settings').click();
    const provSelect = await waitFor(() => document.querySelector('#st-prov'), 5000);
    assert.ok(provSelect, 'settings modal renders');
    const optionNames = provSelect.querySelectorAll('option').map((o) => o.value);
    assert.ok(optionNames.includes('mock') && optionNames.includes('mistral'),
      'provider picker spans keyless mock and mistral: ' + optionNames.join(','));
    assert.equal(provSelect.value, 'mock', 'current role provider preselected');

    // select mistral by hand — the change handler re-renders
    provSelect.value = 'mistral';
    provSelect.onchange?.({ target: provSelect });
    const activate = document.querySelector('.kcheck input');
    const keyInput = document.querySelector('#st-key');
    assert.ok(keyInput, 'mistral shows a key field');

    // refuse the historical foot-gun: a URL pasted as an API key
    activate.checked = true;
    keyInput.value = 'http://127.0.0.1:8787/';
    document.querySelectorAll('.modal button').find((b) => b.textContent.includes('save')).click();
    assert.ok(await waitFor(() =>
      (document.querySelector('.kerr')?.textContent ?? '').includes('web address'), 5000),
    'URL-as-key rejected with an actionable message');

    // short junk refuses too
    keyInput.value = 'x';
    document.querySelectorAll('.modal button').find((b) => b.textContent.includes('save')).click();
    assert.ok(await waitFor(() =>
      (document.querySelector('.kerr')?.textContent ?? '').includes('at least 8 characters'), 5000),
    'short key refused');

    // switch both roles back to the keyless mock — the escape hatch
    const sel2 = document.querySelector('#st-prov');
    sel2.value = 'mock';
    sel2.onchange?.({ target: sel2 });
    assert.equal(document.querySelector('#st-key'), null, 'mock renders no key field — keyless by design');
    document.querySelector('.kcheck input').checked = true;
    document.querySelectorAll('.modal button').find((b) => b.textContent.includes('apply')).click();
    assert.ok(await waitFor(() =>
      document.querySelectorAll('.toast').some((t) => t.textContent.includes('now use mock')), 5000),
    'roles switched to mock from the dashboard');

    // -- role wiring persisted into the operator config ---------------------
    const cfg = JSON.parse(await fs.readFile(path.join(ctx.ws, 'config.json'), 'utf8'));
    assert.equal(cfg.roles.master.provider, 'mock');
    assert.equal(cfg.roles.worker.provider, 'mock');

    shim.restore();
  } finally {
    await teardown(ctx).catch(() => {});
    if (lab) await new Promise((r) => lab.server.close(r)).catch(() => {});
  }
});
