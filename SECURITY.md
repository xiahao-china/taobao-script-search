# Security and privacy

Report a vulnerability using the repository's **Security → Report a
vulnerability** feature when available. Do not include working credentials in
public issues. If private reporting is unavailable, open an issue with only a
high-level description and request a private reporting channel.

## Boundaries

- CDP endpoints are restricted to localhost. Browser control requires the user's
  Chrome debugging authorization or the package's own portable browser.
- The service does not export login Cookies or copy another browser's profile.
  An attached browser may expose the user's logged-in session to local code;
  use this tool only for sessions you intend to authorize.
- Runtime IPC authentication is stored in the local runtime manifest and is
  excluded from business output and Git. The service is a local query tool,
  not a multi-user network service or a sandbox for untrusted callers.
- Login and verification wait for the human; the tool does not bypass them.
- Missing data remains null. Selected-SKU prices require evidence and are not
  final checkout totals. The tool does not place orders or message sellers.

## Distribution

Download releases from this repository. Compare the two file SHA-256 hashes
with the release notes before executing. The embedded payload and its files
are checked during extraction. These hashes detect corruption; they are not
a publisher signature and cannot establish trust in an unknown download.

The launcher uses Windows PowerShell to load the JS header and run bundled
Node. It creates a per-user cache and retains login in an optional dedicated
browser profile. It does not install services, modify PATH or change execution
policies. Do not enable prohibited execution policies to work around an
organization's restrictions.

Update to a new release when bundled runtime/browser versions change. Do not
reuse a browser profile supplied by somebody else. Keep `%LOCALAPPDATA%/TaobaoSearch`
and any custom cache directory private to your account.
