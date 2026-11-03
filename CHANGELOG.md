# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Session warm-up (once per process): when `cna` (device-fingerprint cookie) is
  missing, one homepage visit fetches it; when the sign token is missing, a
  zero-cost dummy request (`mtop.common.getTimestamp`) exchanges it from the
  gateway — business requests no longer bootstrap with an empty token and
  accumulate bad fingerprint. Best-effort: failures fall through to the
  existing token re-sign retry path.
- `batch` now fails fast on `AUTH_REQUIRED` / `RISK_CONTROL`: the run aborts
  immediately and reports `data.aborted = { code, message }` plus `data.note`;
  remaining entries are not executed (no hammering the API with a broken
  session).

### Changed

- Risk-control responses (`RGV587`) are now reported as a dedicated
  `RISK_CONTROL` error instead of being lumped into `AUTH_REQUIRED` — the two
  have different causes (request fingerprint/rate vs. login state) and
  different remedies. `RISK_CONTROL` is deliberately never auto-retried;
  `detail`'s API fallback also skips the second attempt on it (both H5 and PC
  endpoints share the same gateway fingerprint).

## [0.5.0] - 2026-11-03

### Added

- `detail` now carries a `store` block (zero extra requests, from the PC detail
  response): `sellerType` (`B` = Tmall/flagship, `C` = Taobao marketplace) with
  `isTmall`, DSR trio (desc/serv/post scores + peer level), quality scores,
  overall score, credit level, and shop labels (praise rate, dispatch time,
  …). Personal resale listings without shop data report `store: null`.
  C-shop responses hide `shopName` — the seller nickname now falls back as
  `shopName`.
- `detail --reviews` (CLI) / `getReviewSummary` (SDK): one request to
  `mtop.taobao.rate.detaillist.get` v4.0 returning `total` (platform-capped),
  `totalFuzzy` (e.g. `"2000+"`), `foldedDefault` (folded default-praise count)
  and `foldedRatio`. Summary fields arrive as strings and are coerced;
  unparsable values stay `null`. The platform hides neutral/bad counts
  (`hideBadCount`), so no per-grade breakdown exists.
- `meta.coverage.store` flags whether store data was present; unit tests for
  the store record mapping (B/C shops, missing sources).

## [0.4.0] - 2026-11-03

### Added

- Purchase history (`orders` command / `getOrders` SDK method): the
  `已买到的宝贝` list via `mtop.taobao.order.queryboughtlistV2` v1.0 —
  orderId (full precision, from object keys), shop, status, paid/total/discount
  (strings), items with title/sku/qty/price/pic/auctionId. Server fixes the
  page size at 15; `--pages N` merges consecutive pages. Requires
  `ecode=1` login-request flags and the buyertrade referer; pagination lives
  in `meta.page.fields` (currentPage/totalPage/totalNumber).
- `MtopClient.request` accepts `extraParams` and `referer` per call.
- Local tests for the order component-stream parser (multi-`sub`-cell orders,
  money stripping, pagination, empty-response error).

## [0.3.0] - 2026-11-03

### Added

- Pure HTTP MTOP client (`src/core/mtop-client.js`): MD5 signing, automatic
  `_m_h5_tk` renewal, cross-process rate limiting (1.5–3.0 s jitter) — the
  Playwright daemon, DOM adapters and packaging chain are gone.
- `sync-cookie` accepts pasted cookies (`--cookie-string` / `--stdin`).
- Root `cookie.json` user configuration (template: `cookie.example.json`),
  read-only to the program; token renewal and sync-cookie writes go to the
  `.runtime/` cache only, and renewed tokens overlay the config's stale ones.

### Changed

- `batch` reuses one catalog fetch per product (N specs = 1 detail request,
  not N) and now reports `total` / `succeeded` / `failed` alongside `results`.
- `AbortSignal` is honored end-to-end: Ctrl+C interrupts queue waiting and
  in-flight requests (`CANCELLED`).
- CLI: `detail --default` shortcut for single-SKU products; help text matches
  the actual batch input format.

### Fixed

- `getDetail` no longer silently falls back to the item default ("引流") price
  when the requested SKU's price is missing — it raises
  `SKU_PRICE_UNCONFIRMED` instead; the fallback is reserved for
  `{ kind: 'default' }`.
- Variant labels are validated by existence checks only; a real spec label
  containing the word "undefined" is no longer dropped.
- `failure()` reports `INTERNAL_ERROR` instead of the leftover
  `BROWSER_ERROR`; Playwright `Call log:` trimming removed.
- Spec-label lookups in `fetchCatalog` scan the payload once instead of three
  deep-search passes; `parseBody` deduplicated into `src/core/json-body.js`;
  dead v0.2 code removed (`buildSpecs`, `config()`, daemon paths in
  `runtimePaths`).
- `docs/api-contract.md` rewritten to match the v0.3 SDK and CLI.

## [0.2.0] - 2026-10 (daemon era, superseded)

See git history for the Playwright daemon release notes: Windows pid liveness
verdict, single-instance daemon guard, sufei punish wall detection.

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


[0.2.0]: https://github.com/xiahao-china/taobao-script-search/releases/tag/v0.2.0
