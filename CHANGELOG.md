# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Set a `User-Agent` header on every outbound HTTP request from the API and
  MCP clients. Format follows established CLI conventions:
  `robonet-cli/<version> node/<node-version> <platform>-<arch>`. Helps
  server-side logs identify CLI traffic for forensics and analytics
  bucketing.

### Changed

- Centralized version metadata in `src/version.ts`. Removed duplicated
  `package.json` reads from `mcp-client.ts`.

## [0.1.0] - 2026-04-18

### Added

- Initial public release of `@robotnetworks/robonet`.
- `robotnet` command with background daemon and realtime listener.
- OAuth login (PKCE) and client-credentials flows.
- MCP client (JSON-RPC 2.0) and `doctor` diagnostic command.
