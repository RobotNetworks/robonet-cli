# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, Aider, etc.) working in this repository. For human contributors, the same conventions apply — see also `CLAUDE.md` and `README.md`.

## What this repo is

`@robotnetworks/robotnet` — the first-party CLI for Robot Networks. Written in TypeScript, distributed via npm and Homebrew, runs on Node.js 18+.

Docs: https://docs.robotnet.works/cli

## Setup & verification

```bash
npm install
npm run build       # compiles to dist/
npm run typecheck   # no emit, just typecheck
npm test            # runs all tests (Node test runner + tsx)
```

Before proposing a change as complete, always run `npm run typecheck` and `npm test`. Both must pass.

## Layout cheat-sheet

- `src/index.ts` — commander setup and subcommand registration
- `src/commands/<topic>.ts` — one file per subcommand group; each exports `register<Topic>Command(program)`
- `src/api/` — REST client and models
- `src/auth/` — OAuth/PKCE/client credentials, token store
- `src/daemon/` — background listener lifecycle
- `src/realtime/` — WebSocket listener
- `src/output/` — human and JSON formatters
- `src/errors.ts` — `RobotNetCLIError` hierarchy
- `bin/robotnet.js` — published entrypoint (loads `dist/index.js`)
- `tests/*.test.ts` — unit tests, run with `node --import tsx --test`

## Conventions to follow

- **TypeScript strictness**: fully typed signatures, no implicit `any`, `Literal` unions for enums.
- **Errors**: throw a subclass of `RobotNetCLIError` from command paths so the root handler formats them consistently. Do not `process.exit()` inside a command — throw instead.
- **HTTP**: route all requests through `src/api/client.ts`. Do not add raw `fetch` calls in commands.
- **Auth**: never log tokens, secrets, or authorization headers. The token store is the single source of truth for credentials.
- **Output**: support both human output and `--json` for any command that prints data. Use the helpers in `src/output/`.
- **Timestamps**: epoch milliseconds everywhere — storage, API, logs.
- **Naming**: `camelCase` functions/variables, `PascalCase` classes, `SCREAMING_SNAKE_CASE` constants. Be explicit (`getAgentByHandle`, not `get`).
- **No default exports** in new modules. Named exports only.
- **Tests**: every new business-logic module gets tests. Cover error paths, not just happy paths. Use the Node built-in test runner (`node:test`) — do not introduce Jest/Vitest.

## Things to avoid

- Do **not** add new runtime dependencies without a clear justification. The CLI ships globally; every dependency is a supply-chain risk.
- Do **not** edit files under `dist/` — it is build output.
- Do **not** commit `.env` files, tokens, or personal paths. See `.gitignore`.
- Do **not** skip tests or typecheck to "get it working" — fix the root cause.
- Do **not** introduce `any` as a shortcut; narrow unknown values at the boundary.

## How to extend the CLI

Adding a new subcommand:

1. Create `src/commands/<topic>.ts` with a `register<Topic>Command(program: Command)` function.
2. Import it in `src/index.ts` and call it after the existing `register*` calls.
3. Put any HTTP or business logic in a helper module; keep the command file thin.
4. Add `tests/<topic>-command.test.ts` (or extend an existing test file) covering success + error cases.
5. Update `README.md` usage section and add a line to `CHANGELOG.md` under `## [Unreleased]`.

## Release process

1. Bump `version` in `package.json`.
2. Move `## [Unreleased]` entries in `CHANGELOG.md` under the new version with today's date.
3. `npm publish` — `prepublishOnly` enforces build + tests.

## Contact

- Issues & PRs: https://github.com/RobotNetworks/robotnet-cli
- Email: nick@robotnet.works
