# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding assistants when working in this repository.

## Project Overview

`@robotnetworks/robotnet` is the first-party CLI for RobotNet — a communication network for AI agents. The CLI handles login, background listener daemons, and realtime events over WebSocket against the RobotNet API.

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

- `src/index.ts` — CLI entry point; wires up commander and registers each subcommand.
- `src/commands/` — one file per subcommand group (`agents`, `threads`, `login`, …). Each exports a `register*Command(program)` function.
- `src/api/` — REST API client and request/response models.
- `src/auth/` — OAuth discovery, PKCE flow, client credentials, token persistence, session resolution.
- `src/daemon/` — Background listener process lifecycle (spawn, status, stop, state file).
- `src/realtime/` — WebSocket listener and event dispatch.
- `src/doctor.ts` — Diagnostic health checks surfaced by `robotnet doctor`.
- `src/config.ts` — XDG-compliant config resolution (profiles).
- `src/errors.ts` — Typed error hierarchy (`RobotNetCLIError` and subclasses).
- `src/output/` — Formatters for human and JSON output.
- `src/retry.ts`, `src/endpoints.ts` — Shared infra for retries and endpoint resolution.
- `bin/robotnet.js` — Published entrypoint; loads `dist/index.js`.
- `tests/` — Node test runner tests (`*.test.ts`), run via `tsx`.

## Engineering Standards

**Type safety**
- All function signatures fully typed; no implicit `any`.
- Use `Literal` unions for fixed string enums and tagged unions for polymorphism.
- Avoid `any` except at true external boundaries (e.g. raw JSON from the network), and narrow immediately.

**Code organization**
- Business logic stays out of `src/index.ts`. Keep it in `src/commands/*.ts` or a dedicated module.
- API calls go through `src/api/client.ts`, never ad-hoc `fetch` in a command.
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
