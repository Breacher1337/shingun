# shingun (進軍)

Headless CTF tool server and event store for agent workflows (Vibe, Antigravity,
or any MCP / HTTP client). Zero runtime dependencies — pure Node.js ESM.

Your reasoning agent drives; shingun handles CTF ingest (git, local folders,
`.zip`/`.tar.gz` archives, single binaries, `http(s)://` and `tcp://` targets),
persistent bidirectional TCP sessions (`tcp_session`), jailed artifact reads/searches,
append-only JSONL event logging, and an optional headless swarm runner.

## Requirements

- Node.js ≥ 18 (ESM only — no `npm install`; ≥ 20 recommended)
- `git` on `PATH` (for normalized challenge base repos and optional swarm worktrees)

## Quickstart

```sh
node bin/shingun.mjs init-config     # writes config.json (if absent)
node bin/shingun.mjs serve           # HTTP JSON API + /mcp on 127.0.0.1:8787
```

Smoke-test the optional swarm runner offline with the built-in `mock` provider:

```sh
node bin/shingun.mjs run test/fixtures/challenge-easy --profile low-power
```

## Usage (Local + SSH Tunnel)

`shingun serve` binds **`127.0.0.1` only** and rejects non-loopback `Host` headers.

**Local:**

```sh
node bin/shingun.mjs serve --port 8787
# status: http://127.0.0.1:8787/
# mcp:    http://127.0.0.1:8787/mcp
```

**Over SSH (remote CTF box → local agent):**

On the remote box:

```sh
node bin/shingun.mjs serve --port 8787
```

On your workstation:

```sh
ssh -L 8787:127.0.0.1:8787 user@box
```

Point your agent or HTTP client at `http://127.0.0.1:8787` (and MCP Streamable HTTP
at `http://127.0.0.1:8787/mcp`).

## MCP Integration

`src/mcp.mjs` exposes shingun over **stdio** (`shingun mcp`) and **Streamable HTTP**
(`POST|GET|DELETE /mcp` on `shingun serve`). Every MCP tool action records events
into `workspace/challenges/<id>/events/mcp.jsonl` (or `workspace/console/mcp.jsonl`).

### Mount in Vibe

Local stdio:

```sh
vibe mcp add shingun --transport stdio \
  --command node \
  --arg /path/to/shingun/bin/shingun.mjs \
  --arg mcp
```

Remote / SSH-tunneled HTTP:

```sh
vibe mcp add shingun --transport streamable-http --url http://127.0.0.1:8787/mcp
```

### Mount in Antigravity

Add to `mcp_config.json`:

```json
{
  "mcpServers": {
    "shingun": {
      "command": "node",
      "args": ["/path/to/shingun/bin/shingun.mjs", "mcp"]
    }
  }
}
```

### MCP Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `ingest_challenge` | `{url\|path\|bytes?, filename?, title?, hint?, target?, flagFormatRegex?, categoryHint?}` | Ingest git repo, local folder/file, archive URL, base64 zip/tar.gz, or `http(s)://`/`tcp://` target into `challenges/<id>/base` |
| `tcp_session` | `{action: "connect"\|"send"\|"recv"\|"close"\|"list", sid?, host?, port?, data?, encoding?, timeoutMs?, challengeId?}` | Persistent bidirectional TCP socket for interactive `nc` services (capped at `tcp.maxSessions` / `tcp.maxBufferMb` / `tcp.idleTtlMin`) |
| `read_artifact` | `{challengeId, path, offset?, maxBytes?}` | Path-jailed ranged read inside `challenges/<id>/base` (errors `file_too_large` over `mcp.maxFileBytes` when unsliced) |
| `search_artifacts` | `{challengeId, pattern, maxHits?}` | Regex search across `challenges/<id>/base` |
| `submit_flag` | `{challengeId, flag, reasoning?}` | Append `flag.found` to the challenge event store (checked against `flagFormatRegex` if set) |
| `swarm_run` | `{challengeId, workers?}` | Launch an optional headless worker swarm |
| `swarm_status` | `{swarmId}` | Read live or replayed swarm status |

## Ingest Contract

- **Sources:**
  - `url`: git repo URL (`git clone --depth 50`)
  - `path`: local folder OR single file (`.zip` / `.tar.gz` / `.tgz` extracted; any other file stored as a single artifact)
  - `download`: HTTP(S) archive/file download (256 MB cap, 120s timeout, CRC-verified zip & USTAR tar.gz with zip-slip guard)
  - `upload`: raw binary `POST /api/v1/challenges` with non-JSON `Content-Type`; filename from `x-shingun-filename`, `Content-Disposition`, or `?filename=`; metadata (`title`, `hint`, `target`, `targetNote`, `flagFormatRegex`, `categoryHint`) in query params; `201` echoes `uploadedBytes`
  - `none`: target-only challenge (writes `TARGET.md` into `base/`)
- **Target:** `{url, note?}` where `url` is `http(s)://...` or `tcp://host:port`. Orthogonal to `source` and written to `TARGET.md`.

## CLI & HTTP API

```sh
shingun serve [--port N] [--profile P] [--config FILE] [--workspace DIR]
shingun mcp [--profile P] [--config FILE] [--workspace DIR]
shingun run <repoUrl|localPath|archiveUrl> [--target URL] [--target-note NOTE] [--challenge-id ID] [--workers N] [--flag-format REGEX] [--category C]
shingun status [--workspace DIR]
shingun bundle <swarmId> [--workspace DIR]
shingun master <swarmId> <directive>
shingun steer <swarmId> <workerId> <text>
```

HTTP JSON routes (set `SHINGUN_TOKEN` in `.env` to require `Authorization: Bearer <token>`):

- `GET /` — minimal JSON server status
- `POST|GET|DELETE /mcp` — MCP Streamable HTTP endpoint
- `POST /api/v1/challenges` — ingest (JSON or raw binary upload)
- `GET /api/v1/challenges/:id` — challenge metadata
- `POST /api/v1/challenges/:id/swarms` — launch optional swarm
- `GET /api/v1/swarms/:id` — replayed swarm state
- `DELETE /api/v1/swarms/:id` | `POST /api/v1/swarms/:id/stop` — stop swarm
- `GET /api/v1/swarms/:id/bundle` — export `.tar.gz` review bundle
- `POST /api/v1/swarms/:id/workers/:wid/messages`, `GET .../diff`
- `POST /api/v1/master/messages`, `POST /api/v1/master/confirm`, `GET /api/v1/node`
- `GET /api/v1/events?swarm=<id>` — SSE event stream
- `GET /api/v1/providers`, `PUT /api/v1/providers/:provider/key`, `PUT /api/v1/roles`

## Security

- Server binds `127.0.0.1` only, refuses non-loopback `Host` headers (`403 host_forbidden`), and refuses non-loopback `Origin` headers on mutating `/mcp` and `/api/*` requests (`403 origin_forbidden`).
- Challenge inputs and LLM tool calls are untrusted; archive extraction enforces `ingest.maxExtractedBytes` and `ingest.maxExtractedEntries` (`413 ingest_too_large`), and provider calls enforce `providers.callTimeoutMs` (`provider_timeout`) and `providers.transcriptBodyBytes`. Run on a disposable host when executing challenge binaries or swarms.
- Optional spend insurance: one invisible per-swarm hard cap (`budget.perSwarmUsd`) enforced in preflight and rehydrated from `usage.tick` events on resume (`budget.resumed`).
- `.env` secret values are scrubbed before outbound provider calls (`src/scrub.mjs`).

## Tests

```sh
node --test "test/*.test.mjs"
# On Node >= 20, you can also pass --test-concurrency=1
```

## License

Apache-2.0 (see [LICENSE](LICENSE)). A personal tool: maintained for its author's use, shared as-is.
