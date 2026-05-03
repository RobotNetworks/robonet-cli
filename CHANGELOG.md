# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
