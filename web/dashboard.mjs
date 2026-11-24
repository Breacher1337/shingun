/* shingun dashboard — a live overview of the engine, not a client-side app.
 * All state arrives over SSE after a one-time bootstrap; every action is a
 * directive into the engine. Vanilla JS only; no build step. */

// ---- tiny DOM helper ------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'onclick' || k === 'oninput' || k === 'onchange') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel, root) => (root ?? document).querySelector(sel);

// ---- credential -----------------------------------------------------------

const qs = new URLSearchParams(location.search);
{
  const urlToken = qs.get('token');
  if (urlToken) {
    localStorage.setItem('shingun.token', urlToken);
    history.replaceState({}, '', location.pathname);
  }
}
const TOKEN = localStorage.getItem('shingun.token'); // only used when the server opts into gating

// ---- api ------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { code: 'bad_response', message: text.slice(0, 300) } }; }
  if (!res.ok) throw new Error(data?.error?.message ?? `${method} ${path} → ${res.status}`);
  return data;
}

// ---- state ----------------------------------------------------------------

const TERMINAL = ['solved', 'stopped', 'capped'];

const state = {
  swarmId: localStorage.getItem('shingun.lastSwarm') ?? null,
  status: 'unknown',
  final: false,
  challenge: { sourceType: null, sourceValue: null, category: null, flagFormat: null },
  caps: { perSwarmUsd: 0, workerMaxTokens: 0, workerMaxSteps: 0, workerWallClockMin: 0 },
  budget: { usd: 0, tokensIn: 0, tokensOut: 0 },
  flags: [],
  chat: [],            // swarm-scope master thread (bound swarm)
  consoleChat: [],     // console-scope master thread (persists across swarms)
  guard: localStorage.getItem('shingun.guard') ?? 'majors',
  admission: null,
  workers: new Map(), // id → worker record
  inspector: null,   // open worker id
  tab: 'transcript'
};

function workerRec(id) {
  if (!state.workers.has(id)) {
    state.workers.set(id, {
      id,
      persona: '(unknown)',
      status: 'spawning',
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      spawnedAt: Date.now(),
      lastSeenAt: null,
      stallChecks: 0,
      tools: [],
      logs: [],
      diffStats: null,
      flags: [],
      finding: null,
      gone: false,
      reason: null
    });
  }
  return state.workers.get(id);
}

const seqOf = (id) => Number(/-(\d+)$/.exec(String(id ?? ''))?.[1] ?? 0);

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
const fmtUsd = (n) => `$${(n ?? 0).toFixed(4)}`;
const titleize = (s) => String(s ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const dimStyle = 'margin:6px 0 0;color:var(--dim);font-size:11.5px;line-height:1.55';

// ---- shell ----------------------------------------------------------------

const app = $('#app');
app.append(
  h('header', { class: 'topbar' }, ...topbar()),
  h('section', { class: 'hero-shell', id: 'hero-shell' },
    h('div', { class: 'hero-head' }, h('span', { class: 'label' }, 'swarm topology')),
    h('div', { class: 'hero', id: 'hero' })
  ),
  h('section', { class: 'tiles', id: 'tiles' }),
  h('div', { class: 'inspector', id: 'inspector' }),
  h('div', { class: 'toasts', id: 'toasts' }),
  h('footer', { class: 'deck', id: 'deck' })
);

function topbar() {
  return [
    h('span', { class: 'brand' }, 'shingun', h('small', null, ' 進軍')),
    h('span', { class: 'sep' }),
    h('span', { class: 'challenge-name', id: 'tb-challenge', title: '' }, '(no challenge)'),
    h('span', { class: 'chip', id: 'tb-category', style: 'display:none' }),
    h('span', { class: 'sep' }),
    h('span', { class: 'chip', id: 'tb-swarm' }, h('i', { class: 'dot' }), h('span', { id: 'tb-swarm-text' }, 'no swarm')),
    h('span', { class: 'sep' }),
    h('span', { class: 'budget-wrap', id: 'tb-budget' },
      h('span', { class: 'label' }, 'budget'),
      h('div', { class: 'meter', id: 'tb-budget-meter' }, h('i')),
      h('span', { class: 'meter-text', id: 'tb-budget-text' }, '— / —')
    ),
    h('span', { class: 'chip flag-chip', id: 'tb-flags', title: '', onclick: openFlagsPanel }, 'flags ', h('span', { class: 'flagcount' }, '0')),
    h('span', { class: 'grow' }),
    h('span', { class: 'swarm-entry' },
      h('input', { id: 'tb-swarm-input', placeholder: 'swarm id', spellcheck: 'false' }),
      h('button', { onclick: () => connectSwarm($('#tb-swarm-input').value.trim()) }, 'connect')
    ),
    h('button', { id: 'tb-stop', onclick: stopSwarm }, 'stop'),
    h('button', { id: 'tb-export', onclick: exportBundle }, 'bundle'),
    h('button', { id: 'tb-new', onclick: openChallengeModal }, '+ challenge'),
    h('button', { id: 'tb-settings', onclick: openSettings }, 'settings')
  ];
}

const deckEl = $('#deck');
function renderDeckShell() {
  deckEl.replaceChildren(
    h('div', { class: 'deck-head' },
      h('span', { class: 'label' }, 'command deck'),
      h('span', { class: 'who' }, 'master'),
      h('span', { class: 'chip', id: 'deck-status' }, h('i', { class: 'dot' }), h('span', null, 'console')),
      h('span', { class: 'grow', style: 'flex:1' }),
      h('label', { class: 'guard-wrap' }, 'guard', h('select', {
        id: 'deck-guard',
        title: 'instant: everything runs · majors: creates/stops/purges wait for confirm · all: every mutation waits',
        onchange: (e) => {
          state.guard = e.target.value;
          localStorage.setItem('shingun.guard', state.guard);
        }
      },
        ...['instant', 'majors', 'all'].map((m) => h('option', { value: m, selected: m === state.guard }, m)))),
      h('span', { class: 'label', id: 'deck-swarm-label' }, '')
    ),
    h('div', { class: 'deck-log', id: 'deck-log' }),
    h('div', { class: 'deck-inputbar' },
      h('input', { id: 'deck-input', placeholder: 'ask the master…', spellcheck: 'false' }),
      h('button', { id: 'deck-send', onclick: sendDirective }, 'send')
    )
  );
  $('#deck-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#deck-input').disabled) sendDirective();
  });
}

// ---- toasts ----------------------------------------------------------------

function toast(text, kind = '', ttlMs = 6000) {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ttlMs);
  return el;
}

// ---- hero graph -------------------------------------------------------------

function renderHero() {
  const hero = $('#hero');
  const workers = [...state.workers.values()];
  const rect = { w: hero.clientWidth || 900, h: hero.clientHeight || 260 };
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');

  const cols = { challenge: rect.w * 0.13, master: rect.w * 0.5, workers: rect.w * 0.87 };
  const midY = rect.h / 2;
  const nodes = [];

  const chNode = h('div', { class: 'node core' }, h('i', { class: 'dot st-solved' }),
    h('span', null, 'challenge'),
    h('span', { class: 'sub' }, challengeLabel()));
  nodes.push({ el: chNode, x: cols.challenge, y: midY });

  const masterStatus = state.status;
  const masterDot = masterStatus === 'solved' ? 'st-solved'
    : TERMINAL.includes(masterStatus) ? 'st-finished' : 'st-reasoning';
  const mNode = h('div', { class: 'node core' }, h('i', { class: `dot ${masterDot}` }),
    h('span', null, 'master'),
    h('span', { class: 'sub' }, state.challenge.category
      ? `category: ${state.challenge.category}${state.challenge.flagFormat ? ' · ' + state.challenge.flagFormat : ''}`
      : 'triaging…'));
  nodes.push({ el: mNode, x: cols.master, y: midY });

  const n = Math.max(workers.length, 1);
  const nodeH = Math.min(42, Math.max(18, Math.floor((rect.h - 24) / n) - 6));
  workers.forEach((w, i) => {
    const y = rect.h * ((i + 1) / (n + 1));
    const el = h('div', {
      class: `node worker-node${state.inspector === w.id ? ' open' : ''}`,
      onclick: () => openInspector(w.id)
    }, h('i', { class: `dot st-${w.status}` }),
    h('span', null, titleize(w.persona)),
    w.status === 'stalled' || w.stallChecks > 0 ? h('span', { class: 'sub' }, `stalled ×${w.stallChecks}`) : null,
    w.flags.length ? h('span', { class: 'sub' }, `flag: ${w.flags[w.flags.length - 1]}`) : null);
    nodes.push({ el, x: cols.workers, y, worker: true });
  });

  // Edges: challenge → master, master → each worker (cubic béziers).
  const edges = [{ x1: cols.challenge + 66, y1: midY, x2: cols.master - 70, y2: midY, hot: true }];
  workers.forEach((w, i) => {
    const y = rect.h * ((i + 1) / (n + 1));
    edges.push({ x1: cols.master + 70, y1: midY, x2: cols.workers - 90, y2: y,
      hot: ['reasoning', 'toolcall', 'stalled'].includes(w.status) });
  });
  for (const e of edges) {
    const p = document.createElementNS(svgNS, 'path');
    const dx = Math.max(24, (e.x2 - e.x1) / 2);
    p.setAttribute('d', `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`);
    if (e.hot) p.setAttribute('class', 'hot');
    svg.append(p);
  }

  hero.replaceChildren(svg, ...nodes.map((nd) => {
    nd.el.style.left = `${nd.x}px`;
    nd.el.style.top = `${nd.y}px`;
    if (nd.worker) nd.el.style.minHeight = `${nodeH}px`;
    return nd.el;
  }));

  if (state.admission) {
    hero.append(h('div', { class: 'admission-note' },
      `admission paused — ${state.admission.intendingPersona ?? 'worker'} waiting · mem ${state.admission.memAvailableMb}MB < ${state.admission.watermarkMb}MB`));
  }
}

window.addEventListener('resize', () => {
  if (state.workers.size) renderHero();
});

function challengeLabel() {
  const src = state.challenge.sourceValue ?? '';
  const short = String(src).split('/').filter(Boolean).pop() ?? '';
  return short || state.challenge.sourceType || 'challenge';
}

// ---- top bar ----------------------------------------------------------------

function paintTopbar() {
  $('#tb-challenge').textContent = state.challenge.sourceValue
    ? challengeLabel()
    : '(no challenge)';
  $('#tb-challenge').title = state.challenge.sourceValue ?? '';
  const cat = $('#tb-category');
  if (state.challenge.category) {
    cat.style.display = '';
    cat.textContent = state.challenge.category;
  } else {
    cat.style.display = 'none';
  }

  const stChip = $('#tb-swarm');
  stChip.className = `chip ${state.status === 'solved' ? 'ok' : ''}`;
  $('#tb-swarm-text').textContent = state.swarmId ? `${state.swarmId} · ${state.status}` : 'no swarm';
  stChip.querySelector('.dot').style.background = state.status === 'solved' ? 'var(--c-solved)'
    : TERMINAL.includes(state.status) ? 'var(--c-finish)'
    : state.status === 'running' ? 'var(--c-reason)' : 'var(--c-spawn)';

  // Stop and bundle: visible exactly when they can act.
  const liveSwarm = Boolean(state.swarmId) && !TERMINAL.includes(state.status) && !state.final;
  $('#tb-stop').style.display = liveSwarm ? '' : 'none';
  const solvedAndClosed = Boolean(state.swarmId) && state.flags.length > 0 && (TERMINAL.includes(state.status) || state.final);
  $('#tb-export').style.display = solvedAndClosed ? '' : 'none';

  const cap = state.caps.perSwarmUsd || 0;
  const meterEl = $('#tb-budget-meter');
  const pct = cap > 0 ? Math.min(100, (state.budget.usd / cap) * 100) : 0;
  meterEl.className = `meter ${pct >= 100 ? 'over' : pct >= 70 ? 'warn' : ''}`;
  meterEl.querySelector('i').style.width = `${pct}%`;
  $('#tb-budget-text').textContent = `${fmtUsd(state.budget.usd)} / ${fmtUsd(cap)} · ${fmtTok(state.budget.tokensIn + state.budget.tokensOut)} tok`;

  const flagsEl = $('#tb-flags');
  flagsEl.querySelector('.flagcount').textContent = String(state.flags.length);
  flagsEl.title = state.flags.map((f) => `${f.flag} (${f.formatMatch}) via ${f.workerId}`).join('\n');

  // The deck is the console: it works with no swarm bound and survives a
  // swarm going terminal — only a dead server disables it.
  const input = $('#deck-input');
  const send = $('#deck-send');
  const terminal = TERMINAL.includes(state.status) || state.final;
  const swarmLive = Boolean(state.swarmId) && !terminal;
  input.disabled = false;
  send.disabled = false;
  input.placeholder = swarmLive
    ? `directive to ${state.swarmId}…`
    : 'console: ask the master — “attack examples/sqli-lab with 4 workers”';
  deckSpan($('#deck-status'), swarmLive ? state.status : 'console');
}

function deckSpan(chip, text) {
  chip.querySelector('span').textContent = text;
}

// ---- swarm controls (stop / bundle / flags) ---------------------------------

async function stopSwarm() {
  if (!state.swarmId) return;
  try {
    const out = await api(`/api/swarms/${encodeURIComponent(state.swarmId)}/stop`, { method: 'POST', body: {} });
    toast(out.already ? `swarm already ${out.already}` : 'swarm stopping — workers wind down');
  } catch (e) {
    toast(`stop failed: ${e.message}`, 'warn');
  }
}

async function exportBundle() {
  if (!state.swarmId) return;
  try {
    const res = await fetch(`/api/swarms/${encodeURIComponent(state.swarmId)}/bundle`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message ?? `bundle export ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shingun-${state.swarmId}.tar.gz`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('review bundle downloading');
  } catch (e) {
    toast(`bundle failed: ${e.message}`, 'warn', 12000);
  }
}

async function copyText(text, confirmMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(confirmMsg ?? 'copied');
  } catch {
    toast(text, '', 20000);
  }
}

function openFlagsPanel() {
  if (!state.flags.length) return;
  const rows = state.flags.map((f) => h('div', { class: 'flag-row' },
    h('code', { class: 'flag-lit' }, f.flag),
    h('div', { class: 'flag-sub' }, `${f.formatMatch ?? 'unknown'} format · via ${f.workerId ?? 'worker'}`),
    h('button', { onclick: () => copyText(f.flag, `copied ${f.flag}`) }, 'copy'),
    f.reasoning ? h('div', { class: 'flag-why' }, f.reasoning) : null
  ));
  const modal = h('div', { class: 'overlay', onclick: (e) => { if (e.target === modal) modal.remove(); } },
    h('div', { class: 'modal flags-modal' },
      h('h2', null, 'flags'),
      ...rows,
      h('div', { class: 'btns' },
        TERMINAL.includes(state.status) || state.final
          ? h('button', { class: 'primary', onclick: exportBundle }, 'export review bundle')
          : null,
        h('button', { onclick: () => modal.remove() }, 'close')
      )
    )
  );
  app.append(modal);
}

// ---- worker tiles -------------------------------------------------------------

function paintTiles() {
  const tilesEl = $('#tiles');
  const workers = [...state.workers.values()];
  if (!workers.length) {
    tilesEl.replaceChildren(
      h('div', { class: 'empty-state' },
        h('span', { class: 'kanji' }, '進軍'),
        h('p', null, 'No swarm connected. Launch a challenge with ', h('code', null, '+ challenge'),
          ' — the preloaded demo is the bundled SQLi lab at ', h('code', null, 'examples/sqli-lab'), '.'),
        h('p', null, 'Keep the lab serving with ', h('code', null, 'node examples/sqli-lab/app.mjs'),
          ', then watch the swarm exploit it live here.')
      )
    );
    return;
  }
  const caps = state.caps;
  const nodes = workers.map((w) => {
    const meters = h('div', { class: 'meters' },
      meterCell('steps', w.steps, caps.workerMaxSteps),
      meterCell('tokens', w.tokensIn + w.tokensOut, caps.workerMaxTokens),
      meterCell('wall', elapsed(w), caps.workerWallClockMin * 60)
    );
    const last = w.tools.length ? w.tools[w.tools.length - 1] : null;
    const toolLine = last
      ? `${last.name} · ${last.exitCode === 0 ? 'ok' : 'exit ' + last.exitCode} · ${Math.round(last.durationMs)}ms · ${last.argsPreview ?? ''}`
      : 'no tool calls yet';
    return h('div', {
      class: `tile${state.inspector === w.id ? ' open' : ''}${w.gone ? ' gone' : ''}`,
      onclick: () => openInspector(w.id)
    },
    h('div', { class: 'tile-top' },
      h('h3', null, titleize(w.persona)),
      h('span', { class: 'wid' }, w.id),
      h('span', { class: `status-chip st-${w.status}` }, h('i', { class: 'dot' }), w.status + (w.stallChecks ? ` ×${w.stallChecks}` : ''))
    ),
    meters,
    h('div', { class: `last-tool ${last && last.exitCode !== 0 ? 'tool-bad' : 'tool-ok'}` }, toolLine),
    w.finding ? h('div', { class: 'finding' }, w.finding) : null,
    w.flags.length ? h('div', { class: 'finding', style: 'color: #bdeccf' }, `flag: ${w.flags.join(', ')}`)
      : w.diffStats ? h('div', { class: 'last-tool' }, `Δ ${w.diffStats.files} files, +${w.diffStats.insertions}/-${w.diffStats.deletions}`) : null
    );
  });
  tilesEl.replaceChildren(
    h('div', { class: 'tiles-head' },
      h('span', { class: 'label' }, 'workers'),
      h('span', { class: 'chip' }, `${workers.length} spawned`),
      h('span', { class: 'chip' }, `${workers.filter((w) => !w.gone).length} live`)
    ),
    h('div', { style: 'display: contents' }, ...nodes)
  );
}

// The tiles grid is one section; children are placed into it directly.
// (The extra div keeps the head row spanning all columns.)

function meterCell(label, value, cap) {
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  return h('div', { class: 'meter-cell' },
    h('div', { class: `meter ${pct >= 100 ? 'over' : pct >= 70 ? 'warn' : ''}` },
      h('i', { style: `width:${pct}%` })),
    h('div', { class: 'cap' }, `${label} ${value >= 0 ? Math.round(value) : value}${cap ? ' / ' + Math.round(cap) : ''}`)
  );
}

const elapsed = (w) => Math.min(1e9, (Date.now() - new Date(w.spawnedAt).getTime()) / 1000);

function tickClocks() {
  // Continuous meters (wall clock) refresh without waiting for events.
  if (!state.workers.size) return;
  const anyLive = [...state.workers.values()].some((w) => !w.gone);
  if (anyLive) paintWallMeters();
}
setInterval(tickClocks, 1000)?.unref?.();

function paintWallMeters() {
  const cap = state.caps.workerWallClockMin * 60;
  document.querySelectorAll('.tile').forEach((tile, idx) => {
    const w = [...state.workers.values()][idx];
    if (!w) return;
    const cell = tile.querySelectorAll('.meter-cell')[2];
    if (!cell) return;
    const pct = cap > 0 ? Math.min(100, (elapsed(w) / cap) * 100) : 0;
    cell.querySelector('i').style.width = `${pct}%`;
    cell.querySelector('.cap').textContent = `wall ${Math.floor(elapsed(w))}s / ${Math.round(cap)}s`;
  });
}

// ---- command deck ------------------------------------------------------------

/** One action chip: executed (`ok`/`!ok`), or pending with a confirm button. */
function actChip(a) {
  if (a?.pending) {
    const btn = h('button', { class: 'act-btn', onclick: () => confirmAction(a.actionId, btn) }, 'confirm');
    const chip = h('span', { class: 'act wait' }, `${a.op} — awaiting confirm `, btn);
    return chip;
  }
  const d = a.detail ?? {};
  const desc = a.op === 'spawn_worker' ? `spawn ${d.persona ?? a.persona ?? d.workerId ?? '?'}`
    : a.op === 'prune_worker' ? `prune ${d.workerId ?? a.workerId ?? '?'}`
    : a.op === 'stop_swarm' ? 'stop swarm'
    : a.op === 'status_report' ? 'status report'
    : a.op === 'status_node' ? 'node status'
    : a.op === 'create_challenge' ? `challenge ${d.challengeId ?? ''}`.trim()
    : a.op === 'create_swarm' ? `swarm ${d.swarmId ?? ''}`.trim()
    : a.op === 'purge_swarm' ? `purge ${d.swarmId ?? ''}`.trim()
    : a.op === 'remove_challenge' ? `remove ${d.challengeId ?? ''}`.trim()
    : `${a.op ?? 'action'}`;
  const okOk = a.ok !== false;
  const chip = h('span', { class: `act ${okOk ? 'ok' : 'bad'}` }, desc + (okOk ? '' : ' ✕'));
  if (a.detail) chip.title = JSON.stringify(a.detail).slice(0, 300);
  return chip;
}

async function confirmAction(actionId, btn) {
  if (!actionId) return;
  btn.disabled = true;
  try {
    await api('/api/master/confirm', { method: 'POST', body: { actionId } });
    btn.replaceWith(document.createTextNode('✓ confirmed — executing'));
  } catch (e) {
    btn.disabled = false;
    toast(`confirm failed: ${e.message}`, 'warn', 12000);
  }
}

function deckMessage(entry) {
  const who = entry.direction === 'user' ? 'you' : entry.direction === 'note' ? '·' : 'master';
  const head = h('div', { class: 'msg-head' },
    h('span', { class: 'who' }, who),
    entry.scope === 'console' ? h('span', { class: 'who scope' }, 'console') : null);
  const bubble = h('div', { class: `msg ${entry.direction}` },
    head,
    h('div', { class: 'bubble' }, entry.text ?? '')
  );
  if (entry.actions?.length) {
    bubble.append(h('div', { class: 'acts' }, entry.actions.map(actChip)));
  }
  return bubble;
}

function renderDeck() {
  const log = $('#deck-log');
  const all = [...state.chat.map((e) => ({ ...e, scope: e.scope ?? 'sw' })), ...state.consoleChat]
    .sort((a, b) => (a._n ?? 0) - (b._n ?? 0));
  log.replaceChildren(...all.map(deckMessage));
  log.scrollTop = log.scrollHeight;
}

function appendDeck(entry) {
  const log = $('#deck-log');
  log.append(deckMessage(entry));
  while (log.children.length > 300) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function renderDeckStatus(text, ok = false) {
  const chip = $('#deck-status');
  deckSpan(chip, text);
  chip.className = `chip ${ok ? 'ok' : ''}`;
}

async function sendDirective() {
  const input = $('#deck-input');
  const text = input.value.trim();
  if (!text) return;
  // Scope: a live bound swarm takes the directive; otherwise the message
  // goes to the console master, which owns the whole node.
  const terminal = TERMINAL.includes(state.status) || state.final;
  const swarmLive = Boolean(state.swarmId) && !terminal;
  input.value = '';
  renderDeckStatus('master thinking…');
  let spin = null;
  try {
    spin = h('div', { class: 'msg note' }, '…');
    $('#deck-log').append(spin);
    $('#deck-log').scrollTop = $('#deck-log').scrollHeight;
    const body = { text, guard: state.guard };
    if (swarmLive) body.swarm = state.swarmId;
    const out = await api('/api/master/message', { method: 'POST', body });
    spin.remove();
    if (!out?.ok) throw new Error('master did not accept the directive');
    renderDeckStatus(swarmLive ? 'sent — watch the stream' : 'console — watch the thread');
  } catch (e) {
    spin?.remove?.();
    renderDeckStatus('error', false);
    toast(`directive failed: ${e.message}`, 'warn');
  }
}

// ---- inspector ------------------------------------------------------------------

function renderInspector() {
  const panel = $('#inspector');
  const wid = state.inspector;
  const w = wid ? state.workers.get(wid) : null;
  if (!w) { panel.className = 'inspector'; return; }
  panel.className = 'inspector open';

  const tabs = ['transcript', 'commands', 'diff', 'metrics'];
  let body;
  if (state.tab === 'transcript') {
    body = h('div', { class: 'tab-body', id: 'ins-body' },
      w.logs.length
        ? w.logs.slice(-2000).map((l, i) => h('div', { class: `t-line ${l.stream === 'stderr' ? 'err' : l.stream === 'stdout' ? 'sys' : ''}`, 'data-i': i }, l.text))
        : h('div', { class: 't-line sys' }, 'no transcript yet'));
  } else if (state.tab === 'commands') {
    body = h('div', { class: 'tab-body', id: 'ins-body' },
      w.tools.length
        ? w.tools.map((t) => h('div', { class: 'cmd-row' },
            h('span', null, t.name),
            h('span', { class: t.exitCode === 0 ? 'exit-0' : 'exit-x' }, `exit ${t.exitCode ?? '?'}`),
            h('span', null, `${Math.round(t.durationMs ?? 0)}ms`),
            h('span', { class: 'args', title: t.argsPreview ?? '' }, t.argsPreview ?? '')
          ))
        : h('div', { class: 't-line sys' }, 'no commands yet'));
  } else if (state.tab === 'diff') {
    body = h('div', { class: 'tab-body', id: 'ins-body' },
      h('div', { class: 'kv' },
        h('span', null, 'stats: ', h('b', null, w.diffStats ? `${w.diffStats.files} files +${w.diffStats.insertions}/-${w.diffStats.deletions}` : '(captured when the worker stops)'))),
      h('pre', { id: 'ins-diff' }, 'loading diff…'));
    loadDiff(w.id);
  } else {
    const cap = state.caps;
    body = h('div', { class: 'tab-body', id: 'ins-body' },
      h('div', { class: 'metric-row' }, meterCell('steps', w.steps, cap.workerMaxSteps)),
      h('div', { class: 'metric-row' }, meterCell('tokens', w.tokensIn + w.tokensOut, cap.workerMaxTokens)),
      h('div', { class: 'metric-row' }, meterCell('wall (s)', Math.round(elapsed(w)), cap.workerWallClockMin * 60)),
      h('div', { class: 'kv' },
        h('span', null, 'persona: ', h('b', null, titleize(w.persona))),
        h('span', null, 'in/out: ', h('b', null, `${fmtTok(w.tokensIn)} / ${fmtTok(w.tokensOut)}`)),
        h('span', null, 'status: ', h('b', null, w.status)),
        w.reason ? h('span', null, 'reason: ', h('b', null, w.reason)) : null,
        h('span', null, 'spawned: ', h('b', null, new Date(w.spawnedAt).toLocaleTimeString())),
        w.flags.length ? h('span', null, 'flag: ', h('b', null, w.flags.join(', '))) : null)
    );
  }

  panel.replaceChildren(
    h('div', { class: 'inspector-head' },
      h('h3', null, `${titleize(w.persona)} · ${w.id}`),
      h('span', { class: `status-chip st-${w.status}` }, h('i', { class: 'dot' }), w.status),
      h('button', { class: 'inspector-close', onclick: closeInspector }, '×')
    ),
    h('div', { class: 'tabs' }, tabs.map((t) => h('button', {
      class: `tab${state.tab === t ? ' on' : ''}`,
      onclick: () => { state.tab = t; renderInspector(); }
    }, t))),
    body,
    h('div', { class: 'steer-row' },
      h('input', {
        id: 'ins-steer', class: 'steer-input', spellcheck: 'false',
        value: state.steerDraft ?? '',
        placeholder: w.gone ? 'worker closed' : `steer ${w.persona} — one note, next step picks it up`,
        disabled: w.gone === true ? true : undefined,
        oninput: (e) => { state.steerDraft = e.target?.value ?? ''; }
      }),
      h('button', { id: 'ins-steer-send', onclick: () => sendSteer(w.id), disabled: w.gone === true ? true : undefined }, 'steer'))
  );
  const b = $('#ins-body');
  if (b && state.tab === 'transcript') b.scrollTop = b.scrollHeight;
}

async function loadDiff(wid) {
  const pre = $('#ins-diff');
  if (!pre) return;
  try {
    const out = await api(`/api/swarms/${state.swarmId}/workers/${encodeURIComponent(wid)}/diff`);
    pre.textContent = out.diff ?? '(empty diff)';
  } catch (e) {
    pre.textContent = `(no diff yet: ${e.message})`;
  }
}

async function sendSteer(wid) {
  const input = $('#ins-steer');
  const text = input?.value?.trim();
  if (!text || !state.swarmId) return;
  try {
    await api(`/api/swarms/${encodeURIComponent(state.swarmId)}/workers/${encodeURIComponent(wid)}/message`, {
      method: 'POST', body: { text }
    });
    input.value = '';
    state.steerDraft = '';
    toast('steering note queued — the worker picks it up on its next step');
  } catch (e) {
    toast(`steer failed: ${e.message}`, 'warn');
  }
}

function openInspector(wid) {
  state.inspector = wid;
  state.tab = 'transcript';
  paintTiles();
  renderHero();
  renderInspector();
}function closeInspector() {
  state.inspector = null;
  $('#inspector').className = 'inspector';
  paintTiles();
  renderHero();
}

// ---- event application -----------------------------------------------------------

let sseAbort = null;
let consoleAbort = null;
let lastSeqApplied = 0;
let lastConsoleSeq = 0; // console-<seq> lives in its own namespace
let deckArrival = 0;

function applyEvent(ev) {
  // Console lines stream with swarm == null and id console-<n>; swarm
  // events carry their own <swarmId>-<n> — dedupe the two namespaces
  // separately so a console-stream reconnect never duplicates the thread
  // and never drops early swarm events.
  if (ev.swarm == null) {
    const s = seqOf(ev.id);
    if (s && s <= lastConsoleSeq) return;
    if (s) lastConsoleSeq = s;
  } else {
    if (seqOf(ev.id) && seqOf(ev.id) <= lastSeqApplied) return; // backlog dedupe
  }
  const wid = ev.worker;
  const w = wid ? workerRec(wid) : null;
  switch (ev.type) {
    case 'challenge.ingested':
      state.challenge.sourceType = ev.data.sourceType ?? null;
      state.challenge.sourceValue = ev.data.sourceValue ?? null;
      paintTopbar();
      renderHero();
      break;
    case 'master.triage':
      state.challenge.category = ev.data.category ?? state.challenge.category;
      state.challenge.flagFormat = ev.data.flagFormat?.regex ?? null;
      paintTopbar();
      renderHero();
      break;
    case 'master.chat': {
      const scope = ev.data?.scope ?? (ev.swarm == null ? 'console' : 'sw');
      const entry = {
        direction: ev.data.direction,
        text: ev.data.text,
        actions: ev.data.actions ?? [],
        scope,
        _n: ++deckArrival
      };
      if (scope === 'console') state.consoleChat.push(entry);
      else state.chat.push(entry);
      appendDeck(entry);
      if (ev.data.direction === 'master') renderDeckStatus(`master replied${scope === 'console' ? ' · console' : ''}`, true);
      break;
    }
    case 'worker.spawn':
      w.persona = ev.data.persona ?? w.persona;
      w.spawnedAt = new Date(ev.t).getTime();
      paintTiles();
      renderHero();
      break;
    case 'worker.status':
      w.status = ev.data.status;
      if (ev.data.reason) w.reason = ev.data.reason;
      if (TERMINAL.includes(ev.data.status) || ev.data.status === 'finished' || ev.data.status === 'pruned') {
        w.gone = ev.data.status !== 'solved';
      }
      paintTiles();
      renderHero();
      if (state.inspector === w.id) renderInspector();
      break;
    case 'worker.progress':
      w.steps = ev.data.steps ?? w.steps;
      w.tokensIn = ev.data.tokensIn ?? w.tokensIn;
      w.tokensOut = ev.data.tokensOut ?? w.tokensOut;
      w.lastSeenAt = ev.t;
      paintTiles();
      if (state.inspector === w.id && state.tab === 'metrics') renderInspector();
      break;
    case 'worker.log': {
      const line = { seq: ev.data.seq ?? 0, stream: ev.data.stream ?? 'transcript', text: ev.data.text ?? '' };
      w.logs.push(line);
      if (w.logs.length > 2000) w.logs = w.logs.slice(-2000);
      if (line.stream === 'transcript' && line.text) w.finding = line.text.slice(0, 300);
      if (state.inspector === w.id && state.tab === 'transcript') {
        const body = $('#ins-body');
        if (body && body.children.length) {
          body.append(h('div', { class: `t-line ${line.stream === 'stderr' ? 'err' : line.stream === 'stdout' ? 'sys' : ''}` }, line.text));
          while (body.children.length > 2000) body.firstChild.remove();
          body.scrollTop = body.scrollHeight;
        } else {
          renderInspector();
        }
      }
      if (line.stream === 'transcript') paintTiles();
      break;
    }
    case 'worker.tool':
      w.tools.push({ name: ev.data.name, argsPreview: ev.data.argsPreview, exitCode: ev.data.exitCode, durationMs: ev.data.durationMs, truncated: ev.data.truncated });
      if (w.tools.length > 400) w.tools = w.tools.slice(-400);
      paintTiles();
      if (state.inspector === w.id && state.tab === 'commands') renderInspector();
      break;
    case 'worker.diff':
      w.diffStats = ev.data.stats ?? null;
      if (state.inspector === w.id && state.tab === 'diff') loadDiff(w.id);
      paintTiles();
      break;
    case 'worker.stalled':
      w.stallChecks = ev.data.checks ?? w.stallChecks + 1;
      paintTiles();
      renderHero();
      break;
    case 'worker.pruned':
      w.reason = ev.data.reason ?? 'pruned';
      w.gone = true;
      paintTiles();
      renderHero();
      break;
    case 'usage.tick':
      state.budget.usd += Number(ev.data.costUsd ?? 0) || 0;
      state.budget.tokensIn += Number(ev.data.tokensIn ?? 0) || 0;
      state.budget.tokensOut += Number(ev.data.tokensOut ?? 0) || 0;
      paintTopbar();
      break;
    case 'budget.capped':
      toast(`budget capped: ${ev.data.scope ?? ''} ${ev.data.capName ?? ''}`, 'warn');
      break;
    case 'flag.found': {
      const rec = { workerId: ev.data.workerId ?? wid, flag: ev.data.flag, formatMatch: ev.data.formatMatch, reasoning: ev.data.reasoning };
      state.flags.push(rec);
      if (w && !w.flags.includes(rec.flag)) w.flags.push(rec.flag);
      toast(`flag found: ${rec.flag} (${rec.formatMatch}) — ${rec.workerId}`, 'flag', 20000);
      paintTopbar();
      paintTiles();
      renderHero();
      break;
    }
    case 'swarm.update':
      state.status = ev.data.status ?? state.status;
      if (ev.data.final) {
        state.final = true;
        // Terminal: no further events can arrive — stop the stream instead
        // of retrying it forever (a new swarm opens a fresh one).
        sseAbort?.abort();
      }
      paintTopbar();
      renderHero();
      if (TERMINAL.includes(state.status)) renderDeckStatus(state.status, state.status === 'solved');
      break;
    case 'swarm.stop':
      toast(`swarm stopping (${ev.data.by ?? 'user'})`);
      paintTopbar();
      break;
    case 'admission.blocked':
      state.admission = ev.data;
      renderHero();
      break;
    case 'master.digest':
      appendDeck({ direction: 'note', text: `digest rebuilt — ${ev.data.findings?.length ?? 0} findings, ${ev.data.deadEnds?.length ?? 0} dead ends` });
      break;
    case 'swarm.postmortem':
      toast(`post-mortem written: ${ev.data.path}`, '', 15000);
      break;
    case 'bundle.exported':
      toast(`bundle exported: ${ev.data.path}`);
      break;
    default:
      break;
  }
}

// ---- SSE ------------------------------------------------------------------

/** Shared SSE body reader: parses data: blocks and hands each event over. */
async function consumeSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // heartbeat/comment block
      try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* skip a malformed block */ }
    }
  }
}

/**
 * A retry cadence that never pins a Node process open: the underlying
 * timer is unref'd when the runtime supports it, so a drained event loop
 * (tests and CLI one-shots) exits instead of waiting for the next retry.
 * Browsers have no unref and keep the live-reconnect behavior unchanged.
 */
const sleepRetry = (ms) => new Promise((r) => {
  const timer = setTimeout(r, ms);
  timer.unref?.();
});

async function startSse(swarmId) {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();
  const { signal } = sseAbort;
  for (;;) {
    try {
      const res = await fetch(`/api/events?swarm=${encodeURIComponent(swarmId)}`, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        signal
      });
      if (!res.ok || !res.body) throw new Error(`events stream ${res.status}`);
      await consumeSse(res, applyEvent);
    } catch (e) {
      if (signal.aborted) return;
      renderDeckStatus('stream down — retrying');
    }
    if (signal.aborted) return;
    await sleepRetry(2000);
  }
}

/**
 * Console stream: the unscoped /api/events lane replays the persisted
 * console thread and then follows it live. Runs from boot — the console
 * outlives every swarm — and survives server restarts by probing: on
 * stream loss the console goes offline and retries every few seconds
 * until a fresh connect replays the thread (console-<n> ids dedupe the
 * repaint). Probes use a plain interval; in non-browser runtimes a
 * drained loop can tear it down without waiting for the next probe.
 */
let consoleProbe = null;

function startConsoleProbe(signal) {
  if (consoleProbe) return;
  consoleProbe = setInterval(() => {
    if (signal.aborted) { stopConsoleProbe(); return; }
    consoleStreamOnce(signal);
  }, 3000);
  consoleProbe.unref?.();
}

function stopConsoleProbe() {
  if (consoleProbe) { clearInterval(consoleProbe); consoleProbe = null; }
}

async function consoleStreamOnce(signal) {
  try {
    const res = await fetch('/api/events', {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal
    });
    if (!res.ok || !res.body) throw new Error(`console stream ${res.status}`);
    stopConsoleProbe();
    deckSpan($('#deck-status'), state.swarmId && !TERMINAL.includes(state.status) ? state.status : 'console');
    await consumeSse(res, applyEvent);
  } catch (e) {
    if (signal.aborted) { stopConsoleProbe(); return; }
  }
  // Reaching here means the stream ended or failed while never aborted:
  // show it and let the probe bring the console back when it can.
  deckSpan($('#deck-status'), 'console offline');
  startConsoleProbe(signal);
}

async function startConsoleSse() {
  if (consoleAbort) consoleAbort.abort();
  consoleAbort = new AbortController();
  await consoleStreamOnce(consoleAbort.signal);
}

// ---- bootstrap -------------------------------------------------------------

async function loadSwarm(swarmId) {
  try {
    const snap = await api(`/api/swarms/${encodeURIComponent(swarmId)}`);
    state.swarmId = snap.swarmId;
    state.status = snap.status;
    state.final = Boolean(snap.final);
    state.challenge.sourceType = snap.challenge.sourceType;
    state.challenge.sourceValue = snap.challenge.sourceValue;
    state.challenge.category = snap.challenge.category;
    state.challenge.flagFormat = snap.challenge.flagFormat;
    Object.assign(state.caps, snap.caps ?? {});
    state.budget = { ...snap.budget };
    state.flags = [...(snap.flags ?? [])];
    state.chat = [...(snap.masterChat ?? [])].map((m) => ({
      direction: m.direction,
      text: m.text,
      actions: m.actions,
      scope: m.scope ?? 'sw',
      _n: ++deckArrival
    }));
    state.admission = snap.admission ?? null;
    state.workers = new Map();
    state.inspector = null;
    for (const w of snap.workers ?? []) {
      const rec = workerRec(w.id);
      const goneStatuses = ['solved', 'stopped', 'capped', 'finished', 'pruned'];
      Object.assign(rec, {
        persona: w.persona, status: w.status, steps: w.steps,
        tokensIn: w.tokensIn, tokensOut: w.tokensOut,
        stallChecks: w.stallChecks ?? 0, tools: [...(w.tools ?? [])],
        logs: [...(w.logs ?? [])], diffStats: w.diff ?? null,
        flags: [...(w.flags ?? [])], spawnedAt: w.spawnedAt ? new Date(w.spawnedAt).getTime() : Date.now(),
        finding: [...(w.logs ?? [])].reverse().find((l) => l.stream === 'transcript')?.text?.slice(0, 300) ?? null,
        gone: goneStatuses.includes(w.status) && w.status !== 'solved'
      });
    }
    lastSeqApplied = snap.lastSeq ?? 0;
    localStorage.setItem('shingun.lastSwarm', swarmId);
    $('#deck-swarm-label').textContent = swarmId;
    renderDeck();
    paintTopbar();
    paintTiles();
    renderHero();
    renderDeckStatus(TERMINAL.includes(state.status) ? state.status : 'connected', state.status === 'solved');
    startSse(swarmId);
    return true;
  } catch (e) {
    return false;
  }
}

async function connectSwarm(swarmId) {
  if (!swarmId) return;
  const ok = await loadSwarm(swarmId);
  if (!ok) toast(`could not load swarm ${swarmId} — check the id`, 'warn');
}

// ---- settings ----------------------------------------------------------------

/** Mirror of the server's launch preflight, for display purposes. */
function roleIssues(info) {
  const out = [];
  for (const roleName of ['master', 'worker']) {
    const provName = info.roles?.[roleName]?.provider;
    const p = info.providers?.[provName];
    if (!p) { out.push(`role ${roleName}: provider "${provName ?? '—'}" is not configured`); continue; }
    if (p.type === 'openai-compat' && p.hasKey === false) {
      out.push(`role ${roleName}: provider "${provName}" has no API key — swarms cannot launch until one is pasted or the role moves to a keyless provider`);
    }
  }
  return out;
}

/** Set or rotate a provider API key, and point roles at any provider. */
async function openSettings() {
  if ($('#settings-modal')) return;
  const modal = h('div', { class: 'overlay' },
    h('div', { class: 'modal', id: 'settings-modal' }, h('h2', null, 'Settings'),
      h('div', { class: 'kv' }, 'scanning providers…')));
  app.append(modal);
  const info = await api('/api/providers').catch((e) => null);
  if (!modal.isConnected) return; // closed while scanning
  if (!info) {
    modal.remove();
    toast('provider scan failed — is the server running?', 'warn');
    return;
  }
  renderSettings(modal, info);
}

function renderSettings(modal, info, preferName) {
  const names = Object.keys(info.providers ?? {});
  if (!names.length) {
    modal.replaceChildren(
      h('div', { class: 'modal', id: 'settings-modal' }, h('h2', null, 'Settings'),
        h('div', { class: 'kv' }, 'no providers are configured in config.json'),
        h('div', { class: 'btns' }, h('button', { onclick: () => modal.remove() }, 'close'))));
    return;
  }
  const roles = info.roles ?? {};
  const selected = names.includes(preferName) ? preferName
    : (names.includes(roles.worker?.provider) ? roles.worker.provider : names[0]);
  const prov = info.providers[selected];
  const takesKey = prov.type === 'openai-compat' && Boolean(prov.apiKeyEnv);
  const usesItNow = roles.master?.provider === selected || roles.worker?.provider === selected;
  const issues = roleIssues(info);
  const roleLine = `master: ${roles.master?.provider ?? '—'} · worker: ${roles.worker?.provider ?? '—'}`;

  const chips = names.map((n) => {
    const p = info.providers[n];
    const stateTxt = p.hasKey === null ? 'keyless by design' : (p.hasKey ? 'key set' : 'key missing');
    return h('span', { class: `act ${p.hasKey === false ? 'bad' : 'ok'}`, title: n }, `${n}: ${stateTxt}`);
  });

  const select = h('select', { id: 'st-prov', class: 'kinput',
    onchange: (e) => renderSettings(modal, info, e.target?.value ?? selected) },
    names.map((n) => h('option', { value: n, selected: n === selected }, n)));
  const input = h('input', { id: 'st-key', class: 'kinput', type: 'password',
    placeholder: takesKey ? (prov.apiKeyEnv ?? 'API key') : 'no key needed for this provider',
    autocomplete: 'off', spellcheck: 'false' });
  const prevKey = modal.querySelector('#st-key')?.value ?? '';
  input.value = prevKey;
  const activate = h('input', { type: 'checkbox' });
  activate.checked = usesItNow;
  const err = h('div', { class: 'kerr' });

  const body = h('div', { class: 'modal', id: 'settings-modal' },
    h('h2', null, 'Settings'),
    h('div', { class: 'acts' }, ...chips),
    h('label', { class: 'krow' }, 'provider', select),
    takesKey ? h('label', { class: 'krow' }, 'api key', input) : null,
    h('label', { class: 'krow kcheck' }, activate, `use ${selected} for master + worker`),
    h('p', { class: 'dim', style: dimStyle },
      'Roles now: ' + roleLine + '. A pasted key applies immediately and overwrites the stored one. The mock provider runs keyless by design — the bundled dry-run lane.'),
    issues.length ? h('div', { class: 'kerr', style: 'border-left:3px solid var(--c-stall);padding-left:8px' },
      issues.map((i) => h('div', null, '⚠ ' + i))) : null,
    err,
    h('div', { class: 'btns' },
      h('button', {
        class: 'primary', onclick: async () => {
          err.replaceChildren();
          const key = input.value.trim();
          if (takesKey && key) {
            try {
              const res = await api('/api/provider-key', {
                method: 'POST', body: { provider: selected, apiKey: key, activate: activate.checked }
              });
              toast(`key saved for ${res.provider}${res.activated ? ' — roles activated' : ''}`, 'flag', 12000);
            } catch (e) {
              err.replaceChildren(`save failed: ${e.message}`);
              return;
            }
          } else if (activate.checked) {
            try {
              await api('/api/roles', { method: 'POST', body: { both: selected } });
              toast(`master + worker now use ${selected}`, 'flag', 12000);
            } catch (e) {
              err.replaceChildren(`role switch failed: ${e.message}`);
              return;
            }
          } else {
            err.replaceChildren(takesKey ? 'paste a key, or tick “use for master + worker”' : 'tick “use for master + worker” to switch roles');
            return;
          }
          const fresh = await api('/api/providers').catch(() => info);
          renderSettings(modal, fresh, selected);
          checkProviders(); // sync the boot card with the new state
        }
      }, takesKey ? 'save key + roles' : 'apply'),
      h('button', { onclick: () => modal.remove() }, 'close')));

  modal.replaceChildren(body);
}

// ---- challenge launcher ------------------------------------------------------

function openChallengeModal() {
  const modal = h('div', { class: 'overlay' },
    h('div', { class: 'modal' },
      h('h2', null, 'Launch a challenge'),
      h('label', null, 'source type'),
      h('select', { id: 'nl-source' },
        h('option', { value: 'path' }, 'local path'),
        h('option', { value: 'url' }, 'git url')),
      h('label', null, 'value (path or https url)'),
      h('input', { id: 'nl-value', value: 'examples/sqli-lab', spellcheck: 'false' }),
      h('div', { class: 'row' },
        h('div', null, h('label', null, 'flag format regex'), h('input', { id: 'nl-flag', value: 'shingun\\{[^}]*\\}', spellcheck: 'false' })),
        h('div', null, h('label', null, 'category hint'), h('select', { id: 'nl-cat' },
          h('option', { value: '' }, '—'),
          ...['web', 'crypto', 'pwn', 'rev', 'forensics', 'misc'].map((c) => h('option', { value: c }, c)))),
        h('div', null, h('label', null, 'workers'), h('input', { id: 'nl-workers', placeholder: '—' }))),
      h('p', { class: 'dim', style: dimStyle },
        'bundled demo: examples/sqli-lab — the Sakura Surplus SQLi storefront. Have it serving first: ',
        h('code', null, 'node examples/sqli-lab/app.mjs'), '. provider keys live in settings.'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => modal.remove() }, 'cancel'),
        h('button', { class: 'primary', id: 'nl-go' }, 'ingest + launch swarm'))
    ));
  app.append(modal);
  $('#nl-value').focus();
  $('#nl-value').select?.();
  $('#nl-go').addEventListener('click', async () => {
    const go = $('#nl-go');
    const source = $('#nl-source').value;
    const value = $('#nl-value').value.trim();
    if (!value) { toast('value is required', 'warn'); return; }
    go.disabled = true;
    go.textContent = 'ingesting…';
    try {
      const ch = await api('/api/challenges', { method: 'POST', body: {
        source, value,
        ...($('#nl-flag').value.trim() ? { flagFormatRegex: $('#nl-flag').value.trim() } : {}),
        ...($('#nl-cat').value ? { categoryHint: $('#nl-cat').value } : {})
      } });
      go.textContent = 'starting swarm…';
      const gen = await api(`/api/challenges/${encodeURIComponent(ch.challengeId)}/swarm`, { method: 'POST', body: {
        ...($('#nl-workers').value.trim() ? { workers: Number($('#nl-workers').value) } : {})
      } });
      modal.remove();
      toast(`swarm ${gen.swarmId} launched`);
      await loadSwarm(gen.swarmId);
    } catch (e) {
      go.disabled = false;
      go.textContent = 'ingest + launch swarm';
      if (/provider_key_missing|provider_key_invalid|provider_role_unconfigured|API key|api key/i.test(e.message)) {
        toast(`launch blocked: ${e.message}`, 'warn', 20000);
        openSettings();
      } else {
        toast(`launch failed: ${e.message}`, 'warn', 12000);
      }
    }
  });
}

// ---- provider key provisioning ----------------------------------------------

/** Scan providers; surface the launch-blocker card only when a role is stuck. */
async function checkProviders() {
  let info = null;
  try { info = await api('/api/providers'); } catch { return; /* scan degrades silently */ }
  hideKeyCard(); // idempotent; re-render with fresh state
  const issues = roleIssues(info);
  if (issues.length) showKeyCard(issues, info);
}

function hideKeyCard() {
  $('#key-card')?.remove();
  if (location.hash === '#api-key') history.replaceState({}, '', location.pathname);
}

function showKeyCard(issues, info) {
  if ($('#key-card')) return;
  const keyless = Object.entries(info.providers ?? {})
    .find(([, p]) => p.type === 'mock');
  const keylessName = keyless ? keyless[0] : null;
  const subject = info.roles?.worker?.provider ?? info.roles?.master?.provider ?? 'the wired provider';
  const err = h('div', { class: 'kerr' });
  const card = h('div', { id: 'key-card', class: 'key-card' },
    h('div', { class: 'key-card-box' },
      h('h2', {}, `swarms cannot launch yet — ${subject}`),
      h('p', { class: 'dim' },
        issues.map((i) => h('div', null, i.replace(/^role (master|worker): /, '')))),
      h('p', { class: 'dim' },
        'The engine calls a model provider; that needs the provider\u2019s API key (for mistral: console.mistral.ai → API keys). ',
        'That key is NOT this dashboard\u2019s address or access token. Or run the keyless mock provider — the bundled dry-run lane works with no key at all.'),
      err,
      h('div', { class: 'kactions' },
        h('button', {
          class: 'kbtn', onclick: async () => {
            err.replaceChildren();
            try {
              openSettings();
              hideKeyCard();
            } catch (e) {
              err.replaceChildren(`could not open settings: ${e.message}`);
            }
          }
        }, 'open settings'),
        keylessName ? h('button', {
          class: 'kbtn', onclick: async () => {
            err.replaceChildren();
            try {
              await api('/api/roles', { method: 'POST', body: { both: keylessName } });
              toast(`master + worker switched to ${keylessName} — keyless dry-run mode`, 'flag');
              hideKeyCard();
            } catch (e) {
              err.replaceChildren(`switch failed: ${e.message}`);
            }
          }
        }, `switch roles to ${keylessName} (keyless)`) : null,
        h('button', { class: 'kbtn ghost', onclick: hideKeyCard }, 'dismiss')
      )
    )
  );
  document.body.append(card);
}

// ---- boot -------------------------------------------------------------------

renderDeckShell();
paintTopbar();
paintTiles();
renderHero();
startConsoleSse(); // the console thread exists before any swarm does

const last = localStorage.getItem('shingun.lastSwarm');
if (last) {
  loadSwarm(last).then((ok) => { if (!ok) localStorage.removeItem('shingun.lastSwarm'); });
}
checkProviders();
