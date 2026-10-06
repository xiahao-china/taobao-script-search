# Contributing

This repository contains the maintained JavaScript implementation. Local Python
prototypes, purchase records and browser profiles are deliberately excluded.

## Development on Windows x64

Use Node.js 24 or newer. Run `npm ci --ignore-scripts` and `npm test`. Tests use
isolated browser profiles and mocked product pages; they do not require a Taobao
account. Install Chrome, or run `npx playwright install chromium --no-shell` for
the developer test browser. This installation is only for contributors; release
users download two files and need no installation.

Run `npm run build:win11` followed by `npm run test:release` when modifying the
launcher, packaging, process lifetime or bundled dependencies. Read
[distribution](docs/distribution.md) before updating pinned versions or hashes.

## Changes

Keep page selectors in `src/adapters/taobao/dom/`. Preserve the public operations
and `{ok, operation, data, error, meta}` envelope. Never replace an unconfirmed
SKU price with the search-list price. Add a mocked fixture for a new layout or
regression; avoid tests that require a real login, seller interaction or order.

Before committing, run `npm run audit:publish`. This checks the staged Git
snapshot; stage intended files first. `npm run audit:publish -- --ref HEAD`
checks a committed tree instead, which is how CI audits a push. A scanner
finding must be investigated, not hidden by ignoring a whole source directory.
Use [Gitleaks](https://github.com/gitleaks/gitleaks) as an additional secret
scan. Never attach Cookies, storage state, HARs, browser profiles, credentials,
daemon manifests or unredacted product/session payloads to an issue.

Pull requests should explain the trigger, changed behavior, and relevant checks.
Keep unrelated formatting and dependency updates separate. User-visible API
changes should update [the contract](docs/api-contract.md), the [README](README.md)
and the [SKILL](skills/taobao-search/SKILL.md).

## Release

Only Windows 11 x64 is distributed. The maintained code is MIT licensed;
bundled components retain their separate upstream licenses. A release contains
exactly `taobao.js` and `SKILL.md`. Attach them to GitHub Releases, never Git
history. Update [the changelog](CHANGELOG.md) with the version and date in the
same pull request that prepares a release.

A manual release must run the build, the full test suite (`npm test`),
`npm run test:release` and `npm run audit:publish` before tagging; CI runs the
tests and the publication audit on every push but does not publish for you.
