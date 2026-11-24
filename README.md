# shingun (進軍)

Drop in a challenge. A master agent plans, a swarm of worker agents executes
with real shells, and you watch the flags land — all on your own machine.

shingun is a fully local, zero-dependency system for running autonomous AI
agents against security challenges (CTF-style). One Node.js process serves a
live dashboard on `127.0.0.1` while agent swarms work the challenge: each
worker gets its own git worktree and a jailed shell, every step streams to
the dashboard as events, every dollar is capped in code before a provider is
called, and every run leaves a reviewable trail — transcripts, diffs,
post-mortem, export bundle.

## Requirements

- Node.js ≥ 20 (ESM only — there is nothing to `npm install`)
- A disposable machine you are comfortable running challenge code on
  (see [Security](#security) below)

## Quickstart

```sh
node bin/shingun.mjs init-config     # writes config.json + .env.example
node bin/shingun.mjs serve           # dashboard at the printed URL
```

A first smoke run needs no API keys — the built-in `mock` provider walks a
fixture challenge to its flag:

```sh
node bin/shingun.mjs run test/fixtures/challenge-easy --profile low-power
```

To run real models, put a provider key in `.env` (e.g. `MISTRAL_API_KEY=...`)
and point the roles at that provider in `config.json` — the dashboard's
settings panel can do both without a restart.

## CLI

| Command | What it does |
| --- | --- |
| `run <repoUrl\|localPath> [--challenge-id ID] [--workers N] [--budget-usd X] [--profile P]` | Full swarm, headless; events stream to stdout as JSONL |
| `serve [--port N] [--profile P]` | Engine + HTTP API + dashboard on `127.0.0.1` |
| `status` | Challenges + swarms + workers, from the on-disk event stores |
| `steer <swarmId> <workerId> <text>` | Steer one worker (queued into its next step) |
| `init-config` | Write `config.json` + `.env.example` if absent |

## Dashboard

A live overview of the node server: hero graph of challenge → master →
workers, one tile per worker (persona, status, steps/tokens/wall-clock, last
tool, latest finding) with an inspector drawer (transcript / commands / diff /
metrics), and a command deck that talks to the master agent.

Actions that mutate the workspace pass a **guard ledger**: depending on the
guard mode — `instant`, `majors` (default), `all` — proposed actions either
run immediately or park as pending chips until you confirm them one by one.
`purge_swarm` always requires a confirm, in every mode.

## HTTP API

All routes are JSON, bound to `127.0.0.1` only, and (when `SHINGUN_TOKEN` is
set in `.env`) require `Authorization: Bearer <token>`:

- `POST /api/v1/challenges` — ingest a git repo URL, a local folder, a downloaded archive/file URL (`"source":"download"`), or nothing but a live `target` — a pure live-web challenge (the service URL rides the swarm into every prompt and `TARGET.md`)
- `POST /api/challenges/:id/swarm` — launch a swarm
- `GET /api/swarms/:id` — full swarm state, reconstructed by event replay
- `POST /api/swarms/:id/stop`, `POST .../workers/:wid/message`, `GET .../workers/:wid/diff`, `GET .../bundle`
- `POST /api/master/message` — directive to the master (swarm-scoped or console-wide)
- `POST /api/master/confirm {actionId}` — execute one pending action
- `GET /api/node` — node read-back: console thread tail, pending actions, guard mode, swarm summaries
- `GET /api/events?swarm=<id>` — SSE stream; backlog replays from event 0, then live
- `GET|POST /api/providers`, `POST /api/provider-key`, `POST /api/roles` — provider/key management

## Security

Read this before running it against anything real.

- The server binds `127.0.0.1` only and refuses foreign `Host` headers.
  Setting `SHINGUN_TOKEN` in `.env` adds a bearer gate (the dashboard shell
  also accepts `?token=`).
- Challenge content is untrusted input to an LLM whose output drives a
  shell. The path jail and command denylist are speed bumps, not
  containment — run shingun on a disposable machine, not your daily driver.
- Budget caps (per worker / challenge / swarm) are enforced in code.
- Values from `.env` are scrubbed from anything sent to a provider;
  transcripts on disk stay raw. Keys never enter the event store.
- Flags are never auto-submitted. A human validates and submits them.

## Configuration

`config.json` (see `config.example.json` for the full schema with defaults):
concurrency caps, worker limits, stall detection, the memory-watermark
admission gate, budgets, providers, the command denylist, and role →
provider wiring. The `low-power` profile lowers concurrency for small
machines. Providers are OpenAI-compatible: an entry with `apiKeyEnv` reads
its own environment variable, and entries without one share the universal
`OPENAI_API_KEY` — switching provider is a config change, not an
environment rename.

## Workspace layout

```
workspace/challenges/<id>/
  base/            normalized git repo of the challenge
  worktrees/       per-worker checkouts
  scratch/         per-worker private scratch
  tools/           shared per-challenge tool cache
  notes.jsonl      shared findings
  events/          the append-only event store per swarm
  postmortems/     written at swarm end
  bundles/         exportable .tar.gz review bundles
workspace/console/chat.jsonl   the console-wide directive thread
```

## Tests

```sh
node --test test/
```

Fully offline: the `mock` provider needs no API keys.

## Design notes

Zero runtime dependencies by choice — copy the folder, install Node, run.
The event store (append-only JSONL) is the single source of truth; all state
is reconstructed by deterministic replay, so a crash costs you a restart,
not your run.

## License

Apache-2.0 (see [LICENSE](LICENSE)). A personal tool: maintained for its
author's use, shared as-is.
