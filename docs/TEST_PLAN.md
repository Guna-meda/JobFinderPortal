# Test Plan

Automated (`npm test`, node:test, no DB needed) in `server/test/csv.test.js`:
- URL/domain normalization; funding normalization never invents funding
- CSV parsing: header mapping, unmapped columns, bad rows, missing name column
- Filter builder: regex escaping, AND logic
- `cleanPatch`: validation and field whitelist
- Research extractors: same-domain/generic emails only, job-like role links only

Manual/API smoke (run during the build against live Mongo): import + re-import (no duplicates), filters, status PATCH, invalid email rejected, stats, CSV export, research on example.com (honest empty result) and linear.app (careers page, email, roles with sources).

Import/export (`test/import.test.js` pure, `test/api.test.js` against a real MongoDB test DB): quoted commas/newlines/escaped quotes, Unicode, BOM, blanks, ragged rows, malformed/binary/non-UTF-8/empty files, 413 oversize, missing names, mapping validation, same-file-twice, in-file duplicates, similar names not merged, possible duplicates and per-row decisions, protected notes/status/dates/verified data, blank cells never erasing, dry run writes nothing, export filters and formula guard, export -> wipe -> re-import round trip, 3,000-row import.

Research (`research-safety`, `research-extract`, `research-run` need no database; `research-api` uses its own test DB). Local HTTP fixture servers are used, and the test fetcher can reach only those ports.
- Safety: invalid/unsupported URLs (schemes, credentials, ports, internal names, decimal/hex/IPv6/mapped IPs), blocked IP ranges incl. metadata, DNS answers that are private or mixed, DNS resolved once per request and connected to the validated address, redirects to internal/metadata/ftp/file/off-site/loops, timeouts (hang and slow-drip), size cap, non-HTML/compressed, no cookies/credentials, request budget, per-host rate limit, crawl-delay, connection refused.
- Extraction: link classification, role keywords (configurable, whole-word), emails (role-style, company domain only), funding leads (no invention), malformed/hostile HTML, regex-DoS guard.
- Runs: findings with per-finding sources, page/request limits, robots.txt (Disallow, Allow precedence, own-UA group, 404, 500, Disallow all), homepage failures (404/403/429/503/not HTML/timeout/connection/DNS/off-site redirect/private targets), error messages free of internals, not-found semantics.
- Service/API: async start, duplicate-run lock (409), stale lock and restart recovery, manual/verified value preservation and conflict handling, edited accept, funding never marked verified, reject/re-run behaviour, bulk decisions, batch limits, hand-edits clearing research provenance.

Not covered yet: React component tests (including the import wizard), browser E2E, research route tests.
