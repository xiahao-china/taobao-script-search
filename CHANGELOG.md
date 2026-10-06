# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-06

First public release of the maintained JavaScript implementation. The earlier
Python prototype is not part of this repository.

### Added

- Persistent Playwright service: an independent background Node process owns the
  browser, while the CLI and SDK only submit jobs over a local named pipe.
- Unified `{ ok, operation, data, error, meta }` result envelope for `search`,
  `getSpecs` and `getDetail`, with string-typed money and identifiers and `null`
  for fields that could not be confirmed.
- Session reuse: attaches to a running Chrome over CDP on localhost, or starts
  the bundled portable Chromium with `--portable-browser` when Chrome is absent.
- One-navigation price verification for selected SKUs, with batch grouping so a
  repeated product is opened and snapshotted once per batch.
- Adapter split under `src/adapters/taobao/` (`search`, `detail`, `specs`,
  `page`, `dom/*`) so selectors stay isolated from business logic.
- Two-file Windows 11 x64 release: `taobao.js` plus `SKILL.md`, bundling Node,
  Playwright, the business code and a portable browser.
- Publication tooling: `.gitignore` and `.gitattributes` for a clean snapshot,
  `npm run audit:publish` for the staged snapshot, and Gitleaks configuration.
- Repository documentation: architecture, API contract, distribution, project
  structure, validation record and direct-HTTP research notes.

### Security

- Login and verification screens wait for the human; they are never bypassed.
- CDP endpoints are restricted to localhost, and login Cookies are neither
  exported nor copied from another browser profile. The runtime IPC token lives
  in the local manifest and is excluded from business output and Git.

[Unreleased]: https://github.com/xiahao-china/taobao-script-search/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/xiahao-china/taobao-script-search/releases/tag/v0.2.0
