# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `pidAlive` on Windows now confirms a signal-0 "alive" verdict against the
  process table. `OpenProcess` succeeds for a terminated process while any
  handle lingers, so a sandbox-reaped daemon could pass the liveness check as
  a ghost pid — wedging `start` behind "先执行 taobao stop" until the stale
  manifest was removed by hand. If the process table itself cannot be queried,
  the signal-0 verdict is kept.
- Single-instance guard for the resident daemon. Windows named pipes accept
  duplicate same-name listeners, so two daemons could silently own one runtime
  directory. A live manifest pid now refuses a second daemon at startup and
  the CLI refuses a second spawn outright. `taobao stop` also cleans up a
  daemon whose pipe is gone but whose node process lingers — the pid is
  verified to really be our node image before it is killed — instead of
  leaving a zombie that would block every later start.
- The sufei punish wall now arrives as a cross-origin iframe
  (`h5api.m.taobao.com/_____tmd_____/punish`) that the in-page detector cannot
  always see (e.g. when it is nested inside a holder frame). A Playwright-level
  frame scan catches it between polling chunks: the adapters wait for the
  manual slider instead of navigating into the wall, the manual wait itself
  tracks the frame until it is gone, and the post-wait resume no longer
  navigates while a wall is still up. The in-page detector also learned the
  inline `#baxia-punish`/`punish-component` markup, the 验证码拦截 title, and
  the 请按住滑块 copy.
- The Windows launcher no longer writes into `ProcessStartInfo.Environment[Variables]`,
  which Windows PowerShell 5.1 can expose as `$null`: indexing it aborted the
  bootstrap with "Cannot index into a null array", and a partially written
  dictionary could spawn `node.exe` with a gutted environment that died in
  CSPRNG. Settings are published on the parent process environment instead.
- A packaged CLI resolves the daemon entry by what exists on disk (`daemon.cjs`
  next to the bundle) instead of assuming the development layout, which failed
  with `SERVICE_START_FAILED` on every command.
- Verification sliders are detected even when the baxia dialog changes neither
  the URL nor the title and its copy says 推动 rather than 拖动. Clearing the
  wall no longer fires a fresh navigation during the sensitive window: the
  adapter reads the restored page in place and only leaves for the target URL
  when the resume did not land there, and the manual wait no longer consumes
  the data timeout budget.

### Added

- `taobao autostart`: registers the resident daemon as a hidden Windows login
  startup entry (Startup-folder VBS, runtime dir baked into the daemon config)
  and starts the service immediately. A daemon spawned inside a managed tool
  session dies with that session's process tree — the failure signature is a
  remote-debugging consent click landing on an already-dead client. A
  login-time daemon lives outside every session, so every skill call reuses
  one long-lived connection: at most one consent click per Chrome run.
- Regression tests for the packaged daemon resolution, the keyword ceiling of a
  batch search (`MAX_BATCH_SEARCHES = 3`), and the launcher environment handling.

### Added

- `lite` release variant: `dist/taobao-search-win11-x64-lite/` ships Node,
  Playwright and the business code but no browser kernel, cutting the download
  from about 311 MiB to about 55 MiB. `npm run build:win11` builds both
  variants; `build:win11:full` and `build:win11:lite` build one.
- `taobao browser info` and `taobao browser install <chrome-win64.zip | 目录>`
  so a user can supply a kernel themselves. `chrome-win64.zip` is unpacked into
  `%LOCALAPPDATA%/TaobaoSearch/browser/` and shared by every variant on the
  machine, using staging plus rename so a failed install keeps the old kernel.
- `src/browser/chromium.js` resolves the kernel in a documented order: the
  packaged binary, a kernel installed with `browser install`, a kernel another
  variant already extracted into `bundles/*`, then the daily Chrome over CDP.

### Changed

- Missing-browser failures now raise `BROWSER_NOT_FOUND` with the official
  Chrome for Testing and Playwright CDN download URLs in
  `error.details.downloadUrls`, instead of pointing at
  `chrome://inspect/#remote-debugging` on a machine that has no Chrome.
- The release build prints elapsed time every 30s for the Chromium download,
  compression and Base64 steps, plus Base64 progress in 10% increments.

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
