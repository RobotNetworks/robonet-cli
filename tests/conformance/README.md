# Robot Networks operator — ASP conformance harness

Runs the open [ASP conformance suite][suite] against the in-tree local operator. CI gates current CLI releases on this passing.

[suite]: https://github.com/RobotNetworks/asp/tree/main/tests/conformance

## Usage

```bash
# From the robotnet-cli repo root:
npm run conformance
```

The harness:

1. Spawns the operator on a free port (uses `tsx` to run from source — no `npm run build` required).
2. Registers the test agents the suite expects (`@alice.test`, `@bob.test`, `@carol.test`, `@closed.test`) with the right inbound policies.
3. Sets `ASP_OPERATOR_URL` and `ASP_TEST_AGENTS` env vars.
4. Runs `uv run pytest` against `asp/tests/conformance/`.
5. Tears the operator down.

Fails fast (exit 1) if any conformance assertion fails.

## Requirements

- [`uv`][uv] on `PATH`. Install: `brew install uv` or see the upstream docs.
- The `asp` repo checked out as a workspace sibling at `../asp/` (the default), or `ASP_REPO_PATH=/abs/path/to/asp` to override.

[uv]: https://docs.astral.sh/uv/
