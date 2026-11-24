/* Sakura Surplus — storefront (v2.3-debug).
 *
 * A single-file Node target for web/SQL security training. The storefront
 * keeps everything in memory and answers the /search box by pasting the
 * user's query straight into SQL — see search handler. Runs with zero
 * dependencies on Node 18+.
 *
 *   node app.mjs            → http://127.0.0.1:9377/
 *   SQLI_LAB_PORT=9001 node app.mjs
 */

import http from 'node:http';

const PORT = Number(process.env.SQLI_LAB_PORT ?? 9377);
const HOST = '127.0.0.1';

// ---------------------------------------------------------------- database
// Stock booth inventory plus the engagement flag. The flag never touches
// disk: it is seeded dec-encoded at boot and lives only in this process.

const FLAG_SEED = 'c2hpbmd1bnt1bjEwbl9zM2wzY3RfcHduM2RfdGgzX3NoMHB9';
const FLAG = Buffer.from(FLAG_SEED, 'base64').toString('utf8');

const DB = {
  items: [
    { id: 1, name: 'Kunai, three-point', price: 129, blurb: 'Balanced for throwing. Light rust adds character.' },
    { id: 2, name: 'Eggshell gusoku', price: 349, blurb: 'Lamellar spare set. Dented, fully serviceable.' },
    { id: 3, name: 'Smoke gourd', price: 45, blurb: 'Empty. Previous owner swears it once held a smoke bomb.' },
    { id: 4, name: 'Signal whistle', price: 12, blurb: 'Standard-issue chuunin kit surplus. Works.' },
    { id: 5, name: 'Wire spool, thin', price: 18, blurb: 'Strong. Suspiciously cut at one end.' }
  ],
  flags: [
    { id: 1, flag: FLAG }
  ]
};

// ---------------------------------------------------------------- SQL engine
// A deliberate mini-SQL surface (SELECT/WHERE/LIKE/UNION/LIMIT, -- comments)
// so the search box behaves like a real driver. Errors mimic real driver text.

class SqlError extends Error {}

function tokenize(sql) {
  const toks = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && sql[i + 1] === '-') break; // comment to end of line
    if (c === "'") {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw new SqlError('unrecognized token: "\'"');
        if (sql[j] === "'" && sql[j + 1] === "'") { out += "'"; j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        out += sql[j];
        j += 1;
      }
      toks.push({ t: 'str', v: out });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(sql[j])) j += 1;
      toks.push({ t: 'num', v: Number(sql.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
      toks.push({ t: 'id', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    const two = sql.slice(i, i + 2);
    const twoSyms = new Set(['<=', '>=', '<>', '!=']);
    if (twoSyms.has(two)) { toks.push({ t: 'sym', v: two }); i += 2; continue; }
    const oneSyms = new Set(['(', ')', ',', '*', '=', '<', '>']);
    if (oneSyms.has(c)) { toks.push({ t: 'sym', v: c }); i += 1; continue; }
    throw new SqlError(`unrecognized token: "${c}"`);
  }
  return toks;
}

function newParser(toks) {
  let p = 0;
  const kw = (name) => {
    const t = toks[p];
    return t && t.t === 'id' && t.v.toUpperCase() === name;
  };
  const eatKw = (name) => {
    if (!kw(name)) throw new SqlError(`near "${toks[p]?.v ?? ''}": syntax error`);
    p += 1;
  };
  const peek = () => toks[p];
  const eatSym = (v) => {
    const t = toks[p];
    if (!t || t.t !== 'sym' || t.v !== v) {
      throw new SqlError(`near "${toks[p]?.v ?? ''}": syntax error`);
    }
    p += 1;
  };
  const isSym = (v) => {
    const t = toks[p];
    return t && t.t === 'sym' && t.v === v;
  };

  function selectCore() {
    eatKw('SELECT');
    const all = kw('ALL');
    if (all) p += 1; // tolerated like sqlite tolerates SELECT ALL 1
    const items = [];
    for (;;) {
      if (isSym('*')) { eatSym('*'); items.push({ kind: 'star' }); }
      else {
        const t = peek();
        if (!t) throw new SqlError('incomplete input');
        if (t.t === 'num') { p += 1; items.push({ kind: 'lit', v: t.v }); }
        else if (t.t === 'str') { p += 1; items.push({ kind: 'lit', v: t.v }); }
        else if (t.t === 'id') { p += 1; items.push({ kind: 'col', name: t.v }); }
        else throw new SqlError(`near "${t.v}": syntax error`);
      }
      if (isSym(',')) { eatSym(','); continue; }
      break;
    }
    let from = null;
    if (kw('FROM')) {
      p += 1;
      const t = peek();
      if (!t || t.t !== 'id') throw new SqlError('near "FROM": syntax error');
      from = t.v;
      p += 1;
    }
    let where = null;
    if (kw('WHERE')) { p += 1; where = orExpr(); }
    let limit = null;
    if (kw('LIMIT')) { p += 1; const t = peek(); if (!t || t.t !== 'num') throw new SqlError('near "LIMIT": syntax error'); limit = t.v; p += 1; }
    // trailing tokens other than UNION are a syntax error
    if (peek() && !kw('UNION')) throw new SqlError(`near "${peek().v}": syntax error`);
    return { items, from, where, limit, distinct: !all };
  }

  function orExpr() {
    let left = andExpr();
    while (kw('OR')) { p += 1; const right = andExpr(); left = { kind: 'or', left, right }; }
    return left;
  }
  function andExpr() {
    let left = cmpExpr();
    while (kw('AND')) { p += 1; const right = cmpExpr(); left = { kind: 'and', left, right }; }
    return left;
  }
  function cmpExpr() {
    if (isSym('(')) { eatSym('('); const e = orExpr(); eatSym(')'); return e; }
    const lhs = valueNode();
    const t = peek();
    if (t && t.t === 'id' && t.v.toUpperCase() === 'LIKE') {
      p += 1;
      const rhs = valueNode();
      return { kind: 'like', left: lhs, right: rhs };
    }
    if (t && t.t === 'sym' && ['=', '<', '>', '<=', '>=', '<>', '!='].includes(t.v)) {
      p += 1;
      const rhs = valueNode();
      return { kind: 'cmp', op: t.v, left: lhs, right: rhs };
    }
    throw new SqlError(`near "${t?.v ?? ''}": syntax error`);
  }
  function valueNode() {
    const t = peek();
    if (!t) throw new SqlError('incomplete input');
    if (t.t === 'num') { p += 1; return { kind: 'lit', v: t.v }; }
    if (t.t === 'str') { p += 1; return { kind: 'lit', v: t.v }; }
    if (t.t === 'id') { p += 1; return { kind: 'col', name: t.v }; }
    throw new SqlError(`near "${t.v}": syntax error`);
  }

  return {
    parseSelect() {
      const first = selectCore();
      const unions = [];
      while (kw('UNION')) {
        p += 1;
        const all = kw('ALL');
        if (all) p += 1;
        unions.push({ distinct: !all, core: selectCore() });
      }
      if (p !== toks.length) throw new SqlError('incomplete input');
      return { first, unions };
    }
  };
}

function tableRows(name) {
  const rows = DB[name];
  if (!rows) throw new SqlError(`no such table: ${name}`);
  return rows;
}

function evalExpr(node, row, from) {
  switch (node.kind) {
    case 'lit': return node.v;
    case 'col': {
      if (!(node.name in row)) {
        throw new SqlError(`no such column: ${node.name}`);
      }
      return row[node.name];
    }
    case 'and': {
      const l = truthy(evalExpr(node.left, row, from));
      if (!l) return false;
      return truthy(evalExpr(node.right, row, from));
    }
    case 'or': {
      const l = truthy(evalExpr(node.left, row, from));
      if (l) return true;
      return truthy(evalExpr(node.right, row, from));
    }
    case 'cmp': {
      const l = evalExpr(node.left, row, from);
      const r = evalExpr(node.right, row, from);
      switch (node.op) {
        case '=': return l == r; /* eslint-disable-line eqeqeq */
        case '<>': case '!=': return l != r; /* eslint-disable-line eqeqeq */
        case '<': return l < r;
        case '>': return l > r;
        case '<=': return l <= r;
        case '>=': return l >= r;
        default: throw new SqlError(`unknown operator ${node.op}`);
      }
    }
    case 'like': {
      const l = String(evalExpr(node.left, row, from) ?? '');
      const pat = String(evalExpr(node.right, row, from) ?? '');
      const re = new RegExp(
        '^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$',
        'i'
      );
      return re.test(l);
    }
    default: throw new SqlError('internal: unknown expression');
  }
}

const truthy = (v) => Boolean(v) && v !== 0;

function execSelect(sql) {
  const parser = newParser(tokenize(sql));
  const { first, unions } = parser.parseSelect();

  function runCore(core) {
    const from = core.from;
    const rows = from ? tableRows(from) : [{}];
    if (core.items.some((it) => it.kind === 'star') && !from) {
      throw new SqlError('no tables specified');
    }
    const out = [];
    for (const row of rows) {
      if (core.where && !truthy(evalExpr(core.where, row, from))) continue;
      const projected = core.items.map((it) => {
        if (it.kind === 'star') {
          if (!from) throw new SqlError('no tables specified');
          return Object.values(row);
        }
        if (it.kind === 'col') {
          if (!from || !(it.name in row)) throw new SqlError(`no such column: ${it.name}`);
          return row[it.name];
        }
        return it.v;
      });
      out.push({ values: projected.flat(), width: core.items.length });
    }
    return core.limit != null ? out.slice(0, core.limit) : out;
  }

  let acc = runCore(first);
  let accWidth = acc[0]?.width ?? first.items.length;
  for (const u of unions) {
    const rows = runCore(u.core);
    const w = rows[0]?.width ?? u.core.items.length;
    if (w !== accWidth) {
      throw new SqlError('SELECTs to the left and right of UNION do not have the same number of result columns');
    }
    const seen = u.distinct ? new Set(acc.map((r) => JSON.stringify(r.values))) : null;
    for (const r of rows) {
      if (seen) {
        const key = JSON.stringify(r.values);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      acc.push(r);
    }
  }
  return acc.map((r) => r.values);
}

// ---------------------------------------------------------------- rendering

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sakura Surplus</title>
<style>
:root{--bg:#14100f;--panel:#1d1715;--line:#322927;--text:#e8ded6;--dim:#a89484;--acc:#c96f4a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.5 Georgia,'Times New Roman',serif}
header{padding:26px 34px 10px}h1{margin:0;font-size:26px;letter-spacing:.06em}
header .tag{color:var(--dim);font-size:13px;font-style:italic;margin-top:4px}
nav{display:flex;gap:18px;align-items:center;padding:14px 34px;border-bottom:1px solid var(--line)}
form{display:flex;gap:8px}input{background:var(--panel);color:var(--text);
border:1px solid var(--line);border-radius:6px;padding:8px 12px;font:inherit}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 16px;font:inherit;cursor:pointer}
main{padding:20px 34px 90px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.item{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.item h3{margin:0 0 6px;font-size:15px}.item .price{color:var(--acc);font-weight:bold}
.item p{margin:6px 0 0;color:var(--dim);font-size:13px}
.err{border:1px solid #5c2b26;background:#241412;color:#e6b0a0;border-radius:8px;padding:16px;margin:0 34px;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
footer{position:fixed;bottom:0;left:0;right:0;background:var(--panel);color:var(--dim);
border-top:1px solid var(--line);padding:8px 34px;font-size:11.5px;font-family:ui-monospace,Consolas,monospace}
.count{color:var(--dim);font-size:13px;margin:0 0 14px}
a{color:var(--acc)}
</style></head><body>`;

function itemCard(r) {
  const [id, name, price, blurb] = r;
  return `<div class="item"><h3>#${esc(id)} ${esc(name)}</h3>
<span class="price">${esc(price)} ryō</span><p>${esc(blurb)}</p></div>`;
}

function searchResults(sql, rows) {
  return `${PAGE_HEAD}
<header><h1>Sakura Surplus</h1>
<div class="tag">Matchbox district — open 'til the torches die.</div></header>
<nav><form action="/search" method="get">
<input name="q" placeholder="search the shelves…" size="34">
<button>search</button></form>
<a href="/">back to storefront</a></nav>
<main><p class="count">${rows.length} row${rows.length === 1 ? '' : 's'}</p>
<div class="grid">${rows.map(itemCard).join('')}</div></main>
<footer>sakura-surplus/2.3.1 (debug build) · driver: sqlite-emu 1.0 ·
query was: <b>${esc(sql)}</b></footer></body></html>`;
}

function errorPage(sql, message) {
  return `${PAGE_HEAD}
<header><h1>Sakura Surplus</h1>
<div class="tag">Matchbox district — open 'til the torches die.</div></header>
<nav><form action="/search" method="get">
<input name="q" placeholder="search the shelves…" size="34">
<button>search</button></form>
<a href="/">back to storefront</a></nav>
<main><div class="err">sqlite-emu error: ${esc(message)}

executed statement was:
  ${esc(sql)}
</div></main>
<footer>sakura-surplus/2.3.1 (debug build) · driver: sqlite-emu 1.0</footer></body></html>`;
}

function homePage() {
  const rows = DB.items.map((i) => [i.id, i.name, i.price, i.blurb]);
  return `${PAGE_HEAD}
<header><h1>Sakura Surplus</h1>
<div class="tag">Matchbox district — open 'til the torches die.</div></header>
<nav><form action="/search" method="get">
<input name="q" placeholder="search the shelves…" size="34">
<button>search</button></form></nav>
<main><p class="count">Browsing all ${rows.length} wares — or search for something.</p>
<div class="grid">${rows.map(itemCard).join('')}</div></main>
<footer>sakura-surplus/2.3.1 (debug build) · driver: sqlite-emu 1.0</footer></body></html>`;
}

function notFound() {
  return `${PAGE_HEAD}<main><p class="count" style="margin-top:8vh">Nothing on these shelves. Try <a href="/">the storefront</a>.</p></main></body></html>`;
}

// ---------------------------------------------------------------- server

export function createLabServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/') return send(200, homePage());

    if (req.method === 'GET' && url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      // The v2.3-debug shortcut: interpolation straight into the LIKE pattern.
      const sql = `SELECT id, name, price, blurb FROM items WHERE name LIKE '%${q}%'`;
      try {
        const rows = execSelect(sql);
        return send(200, searchResults(sql, rows));
      } catch (e) {
        return send(500, errorPage(sql, e instanceof SqlError ? e.message : String(e?.message ?? e)));
      }
    }
    return send(404, notFound());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

const argvSelf = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const selfUrl = argvSelf.startsWith('/') ? `file://${argvSelf}` : `file:///${argvSelf}`;
const invokedDirectly = Boolean(argvSelf) && import.meta.url === selfUrl;
if (invokedDirectly) {
  createLabServer({ port: PORT, host: HOST }).then(({ port }) => {
    process.stdout.write(`sakura surplus (sqli-lab) listening: http://${HOST}:${port}/\n`);
  }).catch((e) => {
    process.stderr.write(`sqli-lab failed to start: ${e.message}\n`);
    process.exit(1);
  });
}
