"""
shingun-panel — Flask Control & Telemetry Monitor (spec PoC).

Eval build, testing three theses at once:
  1. Transport: Flask can serve SSE proxied from shingun's /api/events.
  2. Position: EXTERNAL observer/remote-control over the existing engine —
     this proxy owns no swarm state; shingun's event stores stay the
     source of truth.
  3. Zero-CDN UI: single embedded HTML page, offline-compatible.

Routes:
  GET  /                    embedded single-file dashboard
  GET  /api/health          shingun serve reachability + auth probe
  GET  /api/events[?swarm=] proxied SSE stream (Bearer via SHINGUN_TOKEN)
  POST /api/steer           proxy → POST /api/swarms/<id>/steer/<wid>
  POST /api/stop            proxy → POST /api/swarms/<id>/stop
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, Response, jsonify, request

SHINGUN_DIR = Path(__file__).resolve().parent.parent
PORT_SHINGUN = int(os.environ.get("SHINGUN_PORT", "8787"))
BASE = f"http://127.0.0.1:{PORT_SHINGUN}"
APP_PORT = int(os.environ.get("PANEL_PORT", "8877"))

app = Flask(__name__)


def token() -> str:
    """SHINGUN_TOKEN from shingun's .env (same source its config scrubs)."""
    for line in (SHINGUN_DIR / ".env").read_text().splitlines():
        if line.startswith("SHINGUN_TOKEN="):
            return line.split("=", 1)[1].strip()
    return ""


def shingun_get(path: str, stream: bool = False, timeout: float = 5):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {token()}"})
    return urllib.request.urlopen(req, timeout=timeout, context=None)  # noqa: S310 (localhost only)


# ------------------------------------------------------------------ health

def reachable() -> dict:
    try:
        with shingun_get("/api/providers", timeout=3) as r:
            body = json.loads(r.read().decode())
            return {"serve": True, "auth": r.status == 200, "providers": body}
    except urllib.error.HTTPError as e:
        return {"serve": True, "auth": False, "error": f"HTTP {e.code}"}
    except OSError:
        return {"serve": False, "auth": False, "error": "shingun serve unreachable"}


@app.get("/api/health")
def health():
    return jsonify(reachable())


# ------------------------------------------------------------------ SSE

@app.get("/api/events")
def events():
    """Proxy shingun's SSE feed through to the browser (adds nothing)."""
    swarm = request.args.get("swarm")
    query = f"?swarm={swarm}" if swarm else ""
    try:
        upstream = shingun_get("/api/events" + query, timeout=10)
    except OSError as e:
        return jsonify({"error": "upstream_sse_unreachable", "detail": str(e)}), 502

    def gen():
        try:
            # Line-wise reads: flush each SSE line as it arrives — byte-reads
            # would buffer until a size quota and starve low-traffic streams.
            for raw in upstream:
                yield raw
        finally:
            upstream.close()

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ actions

def shingun_post(path: str, payload: dict):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST",
                                 headers={"Authorization": f"Bearer {token()}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


@app.post("/api/steer")
def steer():
    body = request.get_json(force=True)
    status, out = shingun_post(f"/api/swarms/{body['swarmId']}/steer/{body['workerId']}",
                               {"text": body["text"]})
    return jsonify(out), status


@app.post("/api/stop")
def stop():
    body = request.get_json(force=True)
    status, out = shingun_post(f"/api/swarms/{body['swarmId']}/stop", {})
    return jsonify(out), status


# ------------------------------------------------------------------ dashboard

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>shingun panel (PoC)</title>
<style>
 :root{--bg:#0b0f14;--fg:#c9d4dd;--hi:#eef4f8;--ok:#3fbf7f;--warn:#d8a24a;
       --bad:#d85555;--line:#1c2733}
 body{background:var(--bg);color:var(--fg);font:14px/1.5 monospace;margin:0;padding:1rem}
 h1{font-size:1rem;color:var(--hi)} .row{display:flex;gap:1rem;align-items:center}
 .pill{border:1px solid var(--line);border-radius:6px;padding:.2rem .6rem}
 .ok{color:var(--ok)} .bad{color:var(--bad)} .warn{color:var(--warn)}
 #feed{border:1px solid var(--line);border-radius:6px;padding:.6rem;height:70vh;
       overflow-y:auto;font-size:12px;white-space:pre-wrap}
 .ev{padding:.05rem 0;border-bottom:1px dotted var(--line)}
</style></head><body>
<h1>shingun panel — Flask PoC</h1>
<div class="row">
  <span id="health" class="pill">checking shingun serve…</span>
  <span id="sse" class="pill warn">SSE: connecting…</span>
</div>
<div id="feed"></div>
<script>
fetch('/api/health').then(r=>r.json()).then(h=>{
  const el=document.getElementById('health');
  el.textContent = h.serve ? `shingun serve: ${h.auth?'authorized':'AUTH FAIL'}` : 'shingun serve: unreachable';
  el.className='pill '+(h.serve&&h.auth?'ok':'bad');
}).catch(()=>{document.getElementById('health').textContent='panel error';});

const feed=document.getElementById('feed');
const es=new EventSource('/api/events');
es.onopen =()=>{document.getElementById('sse').textContent='SSE: live';document.getElementById('sse').className='pill ok';};
es.onerror=()=>{document.getElementById('sse').textContent='SSE: reconnecting…';document.getElementById('sse').className='pill warn';};
es.onmessage=(m)=>{
  let ev; try{ev=JSON.parse(m.data);}catch{ return feed.append('\\n(non-JSON)\\n'+m.data); }
  const line=document.createElement('div'); line.className='ev';
  line.textContent=`${ev.t??''} ${ev.type??ev.type??''} ${ev.worker??''} ${JSON.stringify(ev.data??{})}`;
  feed.prepend(line);
};
</script></body></html>"""


@app.get("/")
def index():
    return Response(PAGE, mimetype="text/html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=APP_PORT, threaded=True)
