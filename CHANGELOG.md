# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-11-22

### Changed

- **Full TypeScript strict migration (`src/**/*.ts`, `tools/*.test.ts`)**:
  migrated all 16 runtime modules and unit test suites from plain JS to strict
  TypeScript (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules`), adding centralized domain &
  protocol types in `src/types.ts` (exported with `.d.ts` declarations via
  `package.json` `exports`). Runtime remains **zero npm dependencies**
  (`typescript` and `@types/node` are `devDependencies` only); `npm run build`
  compiles `src/` -> `build/`, `bin/taobao.js` launches `../build/cli.js`, and
  `npm run pkg` bundles compiled pure `.js` + `.d.ts` into
  `dist/taobao-product-search.zip` (compatible with all Node >= 22).
- Added `npm run build` and `npm run typecheck` scripts; `npm test` and
  `npm run pkg` build automatically before running.

### Fixed

- **Concurrency-safe `reserveSlot` (`src/core/mtop-client.ts`)**: fixed a
  same-millisecond race where concurrent callers seeing `planned <= now` could
  both pass simultaneously. Now serializes per-path callers in-process via a
  Promise queue and writes a unique `owner` token alongside `lastAt` in
  `mtop-pacing.json` so cross-process contenders re-queue cleanly after the
  winning slot.
- **CLI & shop-search hardening**: `--timeout` now validates positive finite
  numbers as `INVALID_ARGUMENT` (instead of throwing `TypeError` ->
  `INTERNAL_ERROR`); `ShopSearchAdapter` now uses `parseEnvMs` (preserving
  explicit `0`) and atomic temp-file + `rename` writes for `shop-wid.json`.

### Added

- **Full pipeline & CLI E2E test suite (`tools/cli-and-pipeline.test.ts`)**:
  covers MTOP POST form-body + MD5 signing, `reserveSlot` concurrency,
  `getDetail` (store/fans enrichment, degrade & fatal rethrow, unconfirmed SKU
  price guard), `getReviewSummary`, `removeFromCart` 3-step loop, `addToCart`
  SKU & failure branches, `ShopSearchAdapter` pagination/cache invalidation,
  and real subprocess CLI E2E checks (`bin/taobao.js`); test count 44 -> 52.

## [0.8.1] - 2026-11-22

### Fixed

- **Flat-map `cookie.json` support & accurate `cookieSummary` (`src/core/cookie-store.js`)**:
  `storeFromRaw` now normalizes flat string-map `cookie.json` entries
  (`{"cookies": {"unb": "...", "cookie2": "...", ...}}`) into internal cookie
  objects instead of passing raw strings through. Previously `cookieHeader`
  silently dropped all non-object login cookies and sent only `_m_h5_tk` /
  `_m_h5_tk_enc` (triggering immediate `RGV587`), while `cookieSummary`
  falsely reported `hasLoginState: true`. `cookieSummary` and `cookieHeader`
  now share the same `isSendable` check (respecting domain, non-empty string
  value, and expiry).
- **`fetchCatalog` endpoint order (`src/adapters/taobao/mtop.js`)**: swapped
  attempts to try `mtop.taobao.pcdetail.data.get` 1.0 first and fall back to
  `mtop.taobao.detail.getdetail` 6.0 only on failure or missing `skuBase`/
  `skuCore` (request logs showed 360/360 H5 `getdetail` calls falling back to
  `pcdetail`, wasting 1 full paced request per item). Fallback events now emit
  a `catalog-fallback` diagnostic line to `.runtime/log/mtop-request-log.jsonl`.
- **`addToCart` rate-limit bypass, token redaction & logging (`src/adapters/taobao/mtop.js`)**:
  reads `minIntervalMs` / `jitterMs` from `this.client.options` (with safe
  5000 ms fallback) instead of `undefined` on `this.options`, fixing a pacing
  bypass; computes `waitMs` right after `reserveSlot`; redacts `_tb_token_` as
  `REDACTED` in request logs; logs honest outcomes (`RISK_CONTROL` /
  `AUTH_REQUIRED` / `CART_ADD_ERROR`) after response classification; uses
  `this.client.fetch` for testability; shares `fetchCartPayload` so
  verification reads no longer write a nested `cart-list` entry in the
  operation log.
- **Cross-process `cna` persistence (`src/core/cookie-store.js`)**: when a
  read-only `cookie.json` lacks a valid `cna`, `loadCookies` now fills it from
  the `.runtime/mtop-cookies.json` warm-up cache instead of re-fetching a new
  device fingerprint on every CLI invocation (a valid `cna` in `cookie.json`
  still takes precedence).
- **Non-JSON punish/TMD detection on MTOP (`src/core/mtop-client.js`)**:
  HTML `_____tmd_____` / `x5sec` / `punish` pages and login redirects returned
  by the gateway are now classified as `RISK_CONTROL` / `AUTH_REQUIRED`
  instead of `MTOP_ERROR` (`ret: []`), preventing fallback or batch loops from
  hammering a risk-controlled session.
- **Rate-limiter edge cases (`src/core/mtop-client.js`)**: explicit `0` in
  `TAOBAO_MTOP_MIN_INTERVAL_MS` / `TAOBAO_MTOP_JITTER_MS` is no longer
  overridden by `|| 5000`; `reserveSlot` contention in the immediate branch
  now re-queues after the competing slot instead of firing concurrently;
  aborting during a pacing wait throws `TaobaoError('CANCELLED')`; temp files
  in `reserveSlot` and `saveCookies` include a random suffix.

### Changed

- **Enhanced non-sensitive request diagnostics (`src/core/mtop-client.js`)**:
  `.runtime/log/mtop-request-log.jsonl` now logs `cookieCount`, `hasLogin`,
  `hasCna`, and `hasToken` (booleans/counts only, zero secret values), `warm-cna`
  probe outcomes, and truncated `bodyHead` on non-JSON gateway errors; test
  count 38 -> 44.

## [0.8.0] - 2026-11-14

### Added

- Cart item removal command `cart-remove <cartId>` (write operation): deletes
  a cart entry via `mtop.trade.update.bag 4.0` — the official H5 cart
  companion write API to `query.bag 5.0` — implementing the dinamicx linkage
  protocol (query.bag pulls the component tree + linkage signature, the
  trigger item's `events.deleteClick` gets `operateItems` merged, the payload
  is double-JSON-wrapped as `{params: <json>}` per the official
  `requestAdaptor`, then POSTed and verified by re-reading query.bag with
  `entryGone=true` / `meta.verification=query-bag-confirmed`). Contract was
  reverse-engineered from the official cart bundle
  (`g.alicdn.com/dinamic/h5-tb-cart/5.0.66/index.min.js`) and live-verified
  2026-11-14 with a probe (`tools/probe-remove-cart.mjs`) on a real test
  entry; 3 requests total, all through the global rate limiter. The operator
  event suffix is `deleteClick.cartAdjustOperate` (the event descriptor's
  type, same for item rows and the settlement bar). Deletion is irreversible
  — the skill workflow requires per-entry user confirmation. `MtopClient`
  gained a POST channel (form-body params, identical MD5 signing); test
  count 36 -> 38.

## [0.7.0] - 2026-11-14

### Added

- Cart content command `cart-list` (read-only): queries the current shopping
  cart via `mtop.trade.query.bag 5.0` on the H5 gateway (login-required
  request, `ecode=1`, referer `main.m.taobao.com/cart/index.html`). The
  response's component dictionary is flattened into `items[]` (cartId /
  itemId / sku{skuId,title} with no-spec items normalized to null / quantity /
  priceText from the pay copy / pic / url / shopName+shopId joined through the
  shop component / isChecked / canCheck), `shops[]`, and a `summary` block
  (itemCount / checkedCount / totalPriceText / totalDiscountText / submitTitle).
  An empty cart is a valid state (shell components present, zero items) and is
  reported as such; only a missing component shell surfaces as `NO_RESULTS`.
- `tools/probe-cart.mjs` one-off probe: live-verified the query.bag 5.0
  request envelope and response structure before implementation.
- Add-to-cart command `cart-add <itemId> [--sku-id <id>] [--quantity N]`
  (write operation): adds an item via the PC web endpoint
  `cart.taobao.com/add_cart_item.htm` (not MTOP) with the minimal parameter
  set `item_id` + `quantity` + `_tb_token_` (CSRF token from the login
  cookies; the legacy `opp`/`ct`/`nekot` params from 2016-era writeups are
  not needed — live-verified 2026-11-14). The GBK HTML response embeds
  `TB.Detail.CartResult` JSON whose `cartQuantity` is the gateway-side
  full-cart count (includes stale/hidden entries — never compare it with
  `cart-list` item count). After the add, the command re-reads
  `query.bag` and confirms the entry (`entryFound=true`,
  `meta.verification=query-bag-confirmed`); re-adding the same item/sku
  increments the existing cart entry's quantity instead of duplicating it.
  Requires `_tb_token_` in the cookies (present in browser-login cookie
  exports). The `--sku-id` path has open-source references (clawhub
  @mayf3/add-to-cart, QGB/QPSU `taobao_trade.py`) but is NOT live-tested —
  first use on a sku item should be followed by a manual `cart-list` check.
  `tools/probe-add-cart.mjs` one-off probe documents the endpoint contract
  (36 tests total, up from 31).

## [0.6.0] - 2026-11-13

### Added

- In-shop item search command `shop-search <keyword> <shopURL|shopId>`:
  pure-GET asynSearch channel (no MTOP signing) with shop wid extraction +
  cache (`.runtime/shop-wid.json`), GBK keyword encoding (zero-dependency
  encoder), and price de-obfuscation via the session-paired WOFF1
  anti-scraping font (zero-dependency cmap/post parser). Prices come back
  decoded when the font map pairs with the page (`priceText` /
  `strikethroughText`), otherwise `null` + `priceUnknown=true` (hybrid
  policy, never guessed). Nickname subdomains and numeric shopIds both work.
- `batch` incremental output: with `--output`, partial results are atomically
  rewritten (temp file + rename) after every completed entry as
  `{ ok: false, partial: true, data: { results, … } }`, so an interrupted run
  (Ctrl+C or a fatal AUTH/RISK abort) keeps the already-finished data on
  disk; the final full envelope overwrites the file on completion.
- Mock-fetch test coverage for the request pipeline: session warm-up,
  `TOKEN_EXPIRED` re-sign, `RGV587` deliberate no-retry, batch progress
  callback, and shop-search wid cache retention (31 tests total, up from 27).
- `detail` now enriches the `store` block with shop-level data fetched via
  one chained `mtop.taobao.shop.impression.logo.get` request (using the
  `sellerId`/`shopId` found in the pcdetail seller node): `fansNum`
  (follower count), `ifHideFansNum`, `goldenSeller`. The extra request
  goes through the global rate limiter and degrades silently on failure —
  `detail` itself is unaffected. Motivation: follower count is a key
  signal when comparing shops.

- Per-request JSONL log at `.runtime/log/mtop-request-log.jsonl` (dedicated
  `log/` folder; legacy files at the old `.runtime` root location are
  migrated automatically on first write): one line per
  real HTTP attempt (timestamp, api/version, ok / error code + `ret`, HTTP
  status, `waitMs` spent on rate-limit, `ms` duration, `probe`/`retry`
  flags). Purpose: reconstruct query cadence when investigating risk-control
  or failures. Auto-rotates to `.old` past 5 MB; write failures are silently
  ignored (bypass only).
- Per-operation JSONL log at `.runtime/log/mtop-operation-log.jsonl`: one
  line per business query (search/specs/detail/orders/review-summary/batch)
  with timestamp, operation type, params (keyword/page/itemId/spec), ok,
  duration, and the FULL business result (`data`: item list with
  title/price/shop/url, detail with price and store block, spec tree) or the
  error `{ code, message }`. Complements the request log — request log covers
  protocol-level cadence, operation log answers "what was queried and what
  came back". Same folder/rotation/bypass rules.
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

- Runtime outputs live under `.runtime/` only: `tools/export-orders-csv.mjs`
  now writes to `.runtime/artifacts/` (previously `artifacts/` at the repo
  root), and the README batch example uses `.runtime/artifacts/` too. The
  root-level `artifacts/` folder is gone (it was already gitignored; local
  CSVs were migrated).
- Risk-control responses (`RGV587`) are now reported as a dedicated
  `RISK_CONTROL` error instead of being lumped into `AUTH_REQUIRED` — the two
  have different causes (request fingerprint/rate vs. login state) and
  different remedies. `RISK_CONTROL` is deliberately never auto-retried;
  `detail`'s API fallback also skips the second attempt on it (both H5 and PC
  endpoints share the same gateway fingerprint).
- `--timeout` now also applies to `shop-search` (previously only MTOP
  commands).
- The operation-log wrapper is shared (`withOperationLog`) by
  `MtopAdapter` and `ShopSearchAdapter`; both clients accept an injectable
  `fetch` for testing, and `AbortSignal.any` usage degrades gracefully on
  runtimes without it (per-request timeout still applies).

### Fixed

- shop-search pagination no longer adds a fixed 5 s `delay` between pages on
  top of the cross-process token bucket (the extra wait was redundant — the
  bucket already anchors to the last request time).
- shop-search no longer overwrites a cached wid with `null` when a shop page
  redesign hides the widget id: the cached wid is kept and used
  (`meta.widSource = 'cache-degraded'`); when neither page nor cache yields a
  wid, a clear `SHOP_SEARCH_ERROR` is raised instead of silently requesting
  with `wid=null`.
- `saveCookies` writes atomically (temp file + rename, same scheme as the
  pacing slot file), so concurrent processes or an interrupted write can no
  longer leave a half-written `mtop-cookies.json` behind.
- Catalog extraction traverses the payload once instead of twice: the old
  `extractCatalog` + `expand` double pass is merged into `expandNodes`
  (index-advancing BFS, no `queue.shift()` O(n) shifts) +
  `extractCatalogFromNodes`.
- Font glyph-name lookup is prototype-chain safe (`Object.hasOwn`); cmap
  format-4 `idDelta` is read as a signed 16-bit integer per the OpenType
  spec (results unchanged, semantics corrected).

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
