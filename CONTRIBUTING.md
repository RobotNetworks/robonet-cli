# Contributing to RobotNet CLI

Thanks for your interest in making the RobotNet CLI better. This guide covers how to report issues, propose changes, and submit pull requests.

## Ways to contribute

- **Report a bug** — open an issue at [github.com/RobotNetworks/robotnet-cli/issues](https://github.com/RobotNetworks/robotnet-cli/issues). Include your OS, Node version (`node -v`), CLI version (`robotnet --version`), and a minimal reproduction.
- **Request a feature** — open an issue describing the use case before writing code. For non-trivial changes we'd rather talk it through than have you invest time in something we can't merge.
- **Fix a bug or add a feature** — follow the PR process below.
- **Improve docs** — typos, clearer examples, and better error messages are all welcome. The README and inline `--help` text live in this repo; the full docs site lives at [docs.robotnet.works/cli](https://docs.robotnet.works/cli).
- **Ask a question** — [Discord](https://discord.gg/A8pZdXfY) is the fastest place to get an answer.

## Development setup

Requires Node.js 18 or later (20+ recommended).

```bash
git clone https://github.com/RobotNetworks/robotnet-cli.git
cd robotnet-cli
npm install

# Run the CLI without building (uses tsx)
npm run dev -- --help

# Build to dist/
npm run build

# Type-check
npm run typecheck

# Run the test suite (Node's built-in runner)
npm test

# Run a single test file
node --import tsx --test tests/token-store.test.ts
```

## Code style

The codebase follows a small set of conventions — see [`AGENTS.md`](./AGENTS.md) for the full list. Highlights:

- **Strict TypeScript** — no implicit `any`, fully typed signatures, `Literal` unions for enums.
- **Errors**: throw a subclass of `RobotNetCLIError` (see `src/errors.ts`) from command paths. The root handler formats them. Don't call `process.exit()` inside a command.
- **HTTP**: route all API calls through `src/api/client.ts`. No ad-hoc `fetch` in commands.
- **Auth**: never log tokens or authorization headers.
- **Naming**: `camelCase` for functions/variables, `PascalCase` for classes, `SCREAMING_SNAKE_CASE` for constants. Prefer explicit names (`getAgentByHandle`, not `get`).
- **Tests**: every new business-logic module should have tests covering success and error paths. We use Node's built-in `node:test` — please don't introduce Jest/Vitest.

## Pull requests

Before opening a PR:

1. **Open an issue first** for anything non-trivial, so we can align on the approach.
2. **Branch from `main`** and keep your PR focused on a single change.
3. **Write or update tests** for your change. `npm test` and `npm run typecheck` must both pass.
4. **Update `CHANGELOG.md`** under an `## [Unreleased]` section.
5. **Keep commits clean** — small, descriptive commits beat one giant "misc fixes" commit. Squash trivial fixups before submitting.

Once the PR is open, CI will run tests across Node 20/22/24 on Ubuntu and macOS. A maintainer will review and either request changes, merge, or close with an explanation.

## Reporting security issues

Please **do not** file security issues as public GitHub issues. Email `nick@robotnet.works` with details; we'll respond and coordinate a fix and disclosure.

## Code of Conduct

Be respectful, assume good intent, and keep discussion focused on the work. Harassment or personal attacks will get you removed from the project spaces (GitHub, Discord).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE) that covers this project.
