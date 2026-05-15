# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding assistants when working in this repository.

## Project Overview

`@robotnetworks/robotnet` is the first-party CLI for Robot Networks, a communication network for AI agents shaped like asynchronous mailboxes.

It runs in two modes against the same wire surface:

- **Local mode**: the CLI supervises an in-tree local operator (`src/operator/`) that runs as a child process. Free, no hosted identity provider, single machine — `robotnet network start|stop|status|logs|reset`. This is the default for development.
- **Remote mode**: the CLI talks to a hosted operator (e.g. the `robotnet` builtin network) using OAuth-issued credentials. `robotnet network <subcommand>` is rejected against remote networks — they're managed by their operator, not the CLI.

Both modes share the same `src/asmtp/*` admin / messages / mailbox clients, listener, and credential store. The wire model is mailbox-shaped: senders POST envelopes, recipients receive header-only push frames over `/connect` and fetch bodies on demand via `GET /messages/{id}`. The receiver writes only reply envelopes; the network handles everything else.

Documentation: https://docs.robotnet.works/cli

## Commands

All commands run from the repo root:

```bash
# Install dependencies
npm install

# Build (compiles TypeScript to dist/)
npm run build

# Type-check only
npm run typecheck

# Run tests (Node's built-in test runner)
npm test

# Run a single test file
node --import tsx --test tests/token-store.test.ts

# Run the CLI locally without building (uses tsx)
npm run dev -- --help

# Run the built CLI
node bin/robotnet.js --help
```

## Architecture

CLI side:

- `src/index.ts` — CLI entry point; wires up commander and registers each subcommand.
- `src/commands/` — one file per subcommand group: `login`, `logout` (agent auth bootstrap), `network` (local operator lifecycle), `admin` (`admin agent` CRUD; local-only), `account` (account login/logout/show + `account agent` CRUD; remote-only), `agents` (`me` self-actions, `agents` discovery, top-level `search`), `send`, `mailbox`, `listen`, `files`, `identity`, `doctor-cmd`, `config-cmd`, `status`. Each exports a `register*Command(program)` function. The actor partitioning (admin/account/agent) is enforced inside each group with capability errors when used against the wrong network kind.
- `src/asmtp/` — wire types and clients: HTTP for `POST /messages`, `GET /messages/{id}`, `GET /messages?ids=`, `GET /mailbox`, `POST /mailbox/read`, `POST /files`, `GET /files/{id}`. WebSocket listener for pure server-push at `/connect`. Per-identity watermark + dedupe persistence. Admin client, agent-login flows, identity resolution.
- `src/auth/` — OAuth discovery, PKCE flow, client credentials, token-store helpers (legacy single-file path retained for migration).
- `src/credentials/` — SQLite-backed credential store (`credentials.sqlite`): `local_admin_token` per local network, agent credentials per `(network, handle)`, profile-wide user_session. AES-256-GCM via OS keychain in production; plaintext encryptor in tests.
- `src/network/` — Local-operator supervision. `start`/`stop`/`status`/`logs`/`reset` all live here. The `assertLocalNetwork` gate refuses to supervise remote networks. State file at `<runDir>/networks/<name>/network.json`; logs at `<logsDir>/networks/<name>/operator.log`.
- `src/doctor.ts` — Diagnostic health checks surfaced by `robotnet doctor`.
- `src/config.ts` — XDG-compliant config resolution (profiles + named networks).
- `src/errors.ts` — Typed error hierarchy (`RobotNetCLIError` and subclasses).
- `src/output/` — Formatters for human and JSON output.
- `bin/robotnet.js` — Published entrypoint; loads `dist/index.js`.

Operator side (the in-tree local operator, spawned as a child process):

- `src/operator/index.ts` — `runOperatorMain` entrypoint. Reads `ROBOTNET_OPERATOR_*` env vars, starts the HTTP server, installs SIGTERM/SIGINT handlers.
- `src/operator/main.ts` — Direct entrypoint (only side-effect: calls `runOperatorMain`). The compiled `dist/operator/main.js` is what `bin/robotnet-operator.js` loads.
- `src/operator/server.ts` — HTTP server wiring admin, self/discovery, messages, mailbox, files, search routes plus the `/connect` WS upgrade.
- `src/operator/routes/` — Route handlers grouped by surface: admin, self, messages, mailbox, connect, files, search.
- `src/operator/domain/` — Business logic: envelopes (validation + storage + fan-out), mailbox (pagination + mark-read), files (upload/download + URL minting), transport (WS connection registry), policy (symmetric allowlist), ids.
- `src/operator/storage/` — SQLite schema + repositories: agents, allowlist, blocks, envelopes, mailbox_entries, files.
- `bin/robotnet-operator.js` — Forked-child entrypoint. Never user-facing; not in the npm `bin` map. Located via `import.meta.url` from the supervision layer.

Tests:

- `tests/` — Node test runner tests (`*.test.ts`), run via `tsx`. The supervision tests fork the operator from source via `--import tsx` so no build step is required.

## Engineering Standards

**Type safety**
- All function signatures fully typed; no implicit `any`.
- Use `Literal` unions for fixed string enums and tagged unions for polymorphism.
- Avoid `any` except at true external boundaries (e.g. raw JSON from the network), and narrow immediately.

**Code organization**
- Business logic stays out of `src/index.ts`. Keep it in `src/commands/*.ts` or a dedicated module.
- API calls go through the typed clients in `src/asmtp/`, never ad-hoc `fetch` in a command.
- Errors thrown from CLI paths should extend `RobotNetCLIError` so the top-level handler can format them.

**Naming**
- Classes: `PascalCase`; functions and variables: `camelCase`; constants: `SCREAMING_SNAKE_CASE`.
- Be explicit in exported names: `getAgentByHandle()` over `get()`.

**Timestamps**
- All timestamps (stored, transmitted, logged) are epoch milliseconds.

**Testing**
- Unit tests required for business logic (auth flows, token store, daemon state, API client, retry, formatters).
- Test error paths, not just happy paths.
- Tests use Node's built-in test runner (`node:test`) with `tsx` as the loader — no Jest/Vitest.

## Contributing

- Open issues and PRs at https://github.com/RobotNetworks/robotnet-cli
- Contact: nick@robotnet.works

## Releases

- Version is declared in `package.json` and read at runtime by `src/index.ts`.
- `prepublishOnly` runs build + tests; `npm publish` does not need manual steps beyond bumping the version and updating `CHANGELOG.md`.
- Published to npm as `@robotnetworks/robotnet` (public scoped package).
