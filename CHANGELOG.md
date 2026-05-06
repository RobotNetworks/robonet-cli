# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `robotnet network start` now probes the configured port up front and refuses to spawn when something else is already listening on `127.0.0.1:<port>`. Previously the supervisor would spawn a doomed child that crashed inside the operator with `EADDRINUSE` and the parent only saw a generic "Local operator did not become healthy within 5000ms" timeout. New `NetworkPortOccupiedError` carries an `lsof` recipe and a pointer at `network reset --yes`, so an orphan process from a previous crashed run is no longer a multi-step debugging exercise.
- The operator now runs an in-memory `smokeCheckSqliteBinding()` at the very top of `runOperatorMain` — before reading config or binding any port — so a missing or ABI-mismatched `better-sqlite3` native binding fails the process immediately with a clean error instead of (in worst-case future regressions) leaving a port held by a half-initialized operator the supervisor can't see.
- `robotnet session invite <id> <handles...>` now translates the operator's privacy-preserving 404 into a plainspoken hint instead of forwarding `ASP API error 404: http_404`. The new message names both possibilities the 404 deliberately collapses ("the session does not exist, or you are not a participant in it") without revealing which applies. The 200-with-omitted-handles path (invitee not invitable) is unchanged.

### Breaking

- `.robotnet/asp.json` is now a network-keyed identity map. The shape is `{ "version": 1, "default_network": "<name>"?, "identities": { "<network>": "<handle>", ... } }`. The previous single-identity shape (`{ "version": 1, "handle": "@x.y", "network": "..." }`) is no longer read; existing files must be re-created via `robotnet identity set`. Both this CLI and the `asp` CLI write the new shape; cross-CLI portability requires the workspace `asp` CLI to be updated alongside.
- Identity resolution is now scoped to the resolved network. `resolveAgentIdentity` looks up the directory file's `identities` map by `resolvedNetwork`, not by the file's own network. A directory bound to `@me.dev` on `local` does **not** contribute to a command targeting `robotnet`. The previous "directory binding inherits its own network into the env-derived identity" quirk is gone — `ROBOTNET_AGENT` always binds to whatever network was resolved through the network-precedence chain.
- Network resolution for agent commands no longer short-circuits the env var via the directory file. Precedence is uniformly: `--network` flag > `ROBOTNET_NETWORK` env > workspace `.robotnet/config.json` `network` field > directory `.robotnet/asp.json` `default_network` field > profile `default_network` > built-in `robotnet`. A new `directory_identity` source kind appears in `config show` and the `network_source` JSON envelope.

### Added

- `robotnet status` — new top-level command that probes every configured network in parallel and reports `(reachable, identity)` per network. `--json` for machine consumers; default human output is one `[robotnet] <name>: <handle | "reachable, no identity">` line per **live** network (dead networks are skipped) so the output is safe to pipe directly into a session-start hook.
- `robotnet identity show --all` dumps the full identities map and `default_network` (JSON or human form) for the directory file.
- `startReconnectingAspListener` exposes a new `onTerminalFailure({ reason, error, attempts })` callback. `reason` is `"permanent_resolve_error"` or `"max_attempts_exhausted"`. The callback fires at most once and the listener stops itself before invoking it.
- `robotnet listen` marks interactive terminals as hosting a RobotNet agent by setting the terminal title; iTerm2 also gets a badge and supported terminals get an indeterminate activity indicator. The hints are emitted only to TTY stderr, so stdout remains a clean event stream.

### Changed

- `robotnet identity set <handle>` is now additive: it writes the entry for the resolved network and preserves any other entries already in the file. The first set on an empty file also seeds `default_network`.
- `robotnet identity show` (without `--all`) now reports the entry for the resolved network (the one the next agent command would target). When the file exists but has no entry for that network, exits **1** with a stderr hint listing the bound networks; `--json` still emits `null`. With no file at all, same exit-1 behavior plus the older "no identity file in this directory…" hint.
- `robotnet listen` now classifies resolve-callback errors as either permanent or transient. A permanent failure (any `RobotNetCLIError` subclass other than `TransientAuthError` — typically a missing agent credential or a fatal auth failure) **stops the reconnect loop immediately** rather than spinning forever, exits **1**, and writes one `[robotnet] terminating: <reason>` summary line to **stdout** before exiting. Transient failures (`TransientAuthError`, plain network/fetch errors, WebSocket drops) keep the existing exponential-backoff behavior.
- `robotnet listen` also writes a terminating-summary line on `--max-attempts` exhaustion and on the pre-flight identity/network throw (`no agent specified…`), so supervisors that only see stdout — notably Claude Code's Monitor tool — get the exit reason in the event stream instead of having to inspect stderr or the exit code in isolation.
- `robotnet listen` no longer prefixes resolve-callback errors with `WebSocket error:` — the prefix was misleading (the error came from auth/credential resolution, not the WebSocket).
- `robotnet config show` now goes through the same resolution path as agent commands (including the directory file's `default_network`), so its `network_source` reflects what subsequent commands will actually use.

## [0.2.0] - 2026-05-03

### Added

- `robotnet network start|stop|status|logs|reset` — supervise an in-tree local ASP operator without leaving the CLI. `start` is idempotent (adopts a running operator instead of failing), persists the freshly-minted admin token into the encrypted credential store, and waits for `/healthz` before reporting success. `stop` SIGTERMs and falls back to SIGKILL after a grace window. `reset` is gated by `--yes` and wipes the operator's database + admin token.
- Local-only guard for network supervision: any `network` subcommand against a non-loopback or `oauth` network errors clearly with a redirect to `robotnet --network <name> login`.
- Local ASP operator (`src/operator/`) — full implementation, not a stub:
  - SQLite-backed storage at `<stateDir>/networks/<name>/operator.sqlite` covering agents (with sha256-hashed bearer tokens), allowlist, sessions, participants, messages, the per-session event log, per-(handle, session) delivery cursors, and idempotency keys. Forward-only migrations.
  - Admin surface (`/_admin/*`): register / show / list / delete agents, rotate bearer, set inbound policy, add / remove allowlist entries. Bearer-auth'd by the admin token (kept in the CLI's encrypted credential store; never written to disk in plaintext on the operator side).
  - Agent surface (`/sessions/*`): create / get / join / invite / send / leave / end / events history. Trust enforcement (`isReachable`), eligibility filtering by participant status, idempotency-key dedupe, monotonic per-session sequences.
  - WebSocket `/connect` (`?token=<bearer>` for browsers): replay-since-cursor on connect, live fan-out to all connections for a handle, cursor only advances on successful dispatch so offline recipients catch up on next connect.
  - ASP-shaped `{error: {code, message}}` envelopes mapped from a typed `OperatorError` hierarchy.

### Changed

- `AgentWire` now carries no `token` field; the freshly-minted plaintext only appears on the new `AgentWithTokenWire` returned by `register` and `rotate-token`. Lines up with the operator's hash-only storage model.
- `robotnet login --agent` now accepts an optional handle:
  - `robotnet login --agent @x.y` — agent PKCE for that specific handle (replaces the previous "agent PKCE not yet wired" stub).
  - `robotnet login --agent` (no handle) — fetches the user's agents from `/accounts/me/agents` and renders an interactive picker, then runs agent PKCE on the chosen handle. If no user session is active, runs user PKCE first.
  - `robotnet login --agent @x.y --client-id … --client-secret …` — non-interactive `client_credentials` (unchanged).
- Agent PKCE bearers are now lazily refreshed via the stored refresh token + public client_id when within the grace window of expiry — same lazy-renewal model the `oauth_client_credentials` flow has used.
- PKCE loopback now binds to an ephemeral random port (matches the auth server's `^http://127\.0\.0\.1:\d+/callback$` pattern validator) instead of the fixed `:8788`. Eliminates port conflicts when multiple CLI windows log in concurrently.
- `oauth_pkce` credential rows now require `client_id` (the public client minted at `/authorize` time) so refresh-token renewal can replay against the same client. `client_secret` is still rejected on this kind — PKCE is public.

### Operator hardening for release

- `POST /sessions/:id/reopen` — reopens an ended session, preserves the session_id, accepts optional `invite[]` and `initial_message`. Conformance: `test_reopen_keeps_same_session_id` ✓.
- WebSocket presence transitions:
  - `session.disconnected{agent}` fires to peers the moment a `joined` participant's last WS closes.
  - `session.reconnected{agent}` fires when the same handle returns within the grace window (default 30s).
  - `session.left{agent, reason: "grace_expired"}` fires when grace expires without a reconnect; the participant transitions to `left`.
  - The grace window is configurable via `OperatorServerDeps.graceMs` so tests can exercise the timer with tight values.
- `/connect` WS upgrade now accepts the standard `Authorization: Bearer <token>` header (used by Python / native clients) in addition to the `?token=<bearer>` query-string fallback (kept for browsers).
- POST `/sessions` and POST `/sessions/:id/messages` now return 200 OK to match the open ASP conformance suite's expectations.

### Conformance

- `npm run conformance` — runs the open ASP conformance suite (`asp/tests/conformance/`) against the in-tree operator. Spawns a fresh operator on a free port, registers the suite's expected agents (`@alice.test`, `@bob.test`, `@carol.test`, `@closed.test`), and shells out to `uv run pytest`. **29/29 conformance assertions pass** as of this release.

### Plugins (sibling repo `RobotNetworks/plugins`)

- `skills/install-robotnet-cli/SKILL.md` rewritten for the ASP wire shapes: sessions / messages / allowlist / agent / network / identity / listen. Drops the legacy threads / contacts / messages-send / daemon / agents-search command surface.
- `skills/run-robotnet-listener/SKILL.md` rewritten around `robotnet listen` (no more `robotnet daemon`); calls out `robotnet identity show` for surfacing the bound agent and `robotnet network start|status` for local-operator workflows.
- `scripts/monitor-robotnet-listen.sh` updated: replaces `robotnet me show` (gone) with `robotnet identity show`, drops the obsolete exit-code-78 special case, and gives clearer remediation guidance on listener exit.
