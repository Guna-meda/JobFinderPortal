# Implementation Audit

Audited against the actual code on 2026-10-22. "Reproduced" means I ran it. "By inspection" means I read the code but did not execute it. Reproductions used a scratch server on port 4100 with a throwaway database (`audit-scratch`, since dropped). The real `startup-finder` database was not touched.

## Check results

| Check | Result |
|---|---|
| `npm test` (server, node:test) | 9/9 pass (8 originally plus 1 added with a fix below) |
| `npm --prefix client run lint` (oxlint) | 0 errors, 3 warnings (see P2-6) |
| `npm --prefix client run build` | Passes |
| `npm audit` (server and client) | 0 vulnerabilities |
| Live API smoke against MongoDB | Ran. Results below |
| Browser/E2E testing | **Not done.** The Chrome extension did not respond, so the React UI has never been exercised in a real browser |
| Test coverage | No coverage tool. The 9 tests cover only the pure helpers in `lib/` plus `cleanPatch`. Routes, import-into-DB, research fetching, robots.txt and all React code have **no tests** |

## Fixed during this audit

1. **Funding invented from free text** (`server/src/lib/csv.js`, `normalizeFundingStatus`). Unanchored regexes turned "Yet to raise" and "yc" into `funded`, and "Not sure", "Not funded" and "none" into `bootstrapped`. The patterns now match whole values only, with a regression test. This was a direct violation of "never invent funding".
2. **Oversized upload returned 500** (`server/src/app.js` error middleware). It now returns 413 "File too large (10 MB max)". Reproduced before the fix with a 12 MB file and re-verified after.

Everything else below is **not fixed**, pending your decision.

---

## P0: Must fix (trust and data integrity)

### P0-1. Research overwrites manual edits, and edits leave stale "verified" flags
Files: `server/src/app.js` (`POST /api/companies/:id/research`, `cleanPatch`), `server/src/lib/research.js`.
- **Reproduced:** research a company, then PATCH `careersUrl=https://totally-other.com/jobs`, `hasRelevantRoles=no` and `contactEmail=me@mine.com`. The response still has `careersVerified: true`, `careersSourceUrl: https://linear.app/`, and `contactEmailSourceUrl: https://linear.app/contact`. The UI therefore shows a "verified" careers link and email source for values the research never saw.
- **Reproduced:** clicking "Re-run research" afterwards restored `careers=https://linear.app/careers`, `email=hello@linear.app` and `hasRelevantRoles=yes`. All three manual edits were silently lost. The roles case is worse: research sets `unknown` when it finds nothing, which would also erase a manual `yes` or `no`.
- **Fix direction:** in PATCH, when `careersUrl` or `contactEmail` changes, clear the matching `*Verified` and `*SourceUrl` fields. In research, fill only blank fields or fields that already have a research source, never overwrite a manual value, and never downgrade `hasRelevantRoles`.

### P0-2. Import silently discards values from mapped columns
Files: `server/src/lib/csv.js` (`parseCompanies`, `ALIASES`).
- **Reproduced** with headers `Company,Website,Status,Funding,Email,Description`:
  - Website `N/A`, email `hiring at a dot com`, Status `Hot lead` and Funding `Series A $5M led by X` were all dropped.
  - Only columns that fail to map are preserved in `extra`. Mapped columns whose value fails normalization vanish with no warning, which breaks the "preserve everything" intent.
  - The generic aliases `status`, `description`, `tags`, `link`, `url`, `funding` and `stage` can capture a column that means something else. For example, a "Status" column about funding becomes `appStatus` and is thrown away.
- **Reproduced:** two rows for the same company in one file. The second is skipped (counted in `skipped`) and its notes are lost.
- **Fix direction:** when a mapped value is non-empty but doesn't normalize, append `Column: value` to `notes` or to `extra`. Return a per-column mapping preview so the user can see what was matched. Consider dropping the generic aliases or requiring confirmation.

### P0-3. SSRF in website research is only partly mitigated
Files: `server/src/lib/research.js` (`assertPublic`, `fetchText`, `robotsAllows`, `isPrivateIp`).
- **Reproduced:** a company with website `https://httpbin.org/redirect-to?url=http://127.0.0.1:4100/api/health` made the server fetch the internal URL. The log shows `(200, not html)`, which means a 200 from the internal service was received. The private-IP check runs only on the *initial* hostname, and `fetch` uses `redirect: 'follow'`.
  - Impact: an internal HTML page would be parsed, and its emails and links stored on the company.
- **By inspection:**
  - `robotsAllows` calls `fetch` with no `assertPublic` and follows redirects, so a blind request to an internal host is possible.
  - DNS rebinding: the lookup and the actual connection resolve separately.
  - `isPrivateIp` handles IPv6 only for `::1`, `fc/fd`, `fe80` and `::ffff:127.*`. IPv4-mapped private ranges such as `::ffff:10.0.0.1` and `::ffff:192.168.x.x` pass, and so does CGNAT `100.64.0.0/10`.
  - The README claims "blocks private IP ranges", which is an overstatement.
- **Direct private IP is blocked** (`127.0.0.1:4100` was refused, reproduced).
- **Fix direction:** use `redirect: 'manual'` and re-validate each hop (limit 3). Run `assertPublic` before `robots.txt` too. Pin the resolved IP, for example with an undici `Agent` with a custom `lookup`. Extend the IP checks to IPv4-mapped IPv6 and `100.64/10`.

## P1: Should fix soon

### P1-1. API is open to any website (CORS `*`, no auth)
File: `server/src/app.js` (`app.use(cors())`).
- **Reproduced:** an OPTIONS preflight from `Origin: http://evil.example` returns `Access-Control-Allow-Origin: *` and allows PATCH and DELETE.
- Any page open in your browser can read all your companies (`GET /api/companies`), delete or edit them, and trigger research fetches against `localhost:4000`.
- The Vite proxy makes CORS unnecessary in dev. **Fix:** remove `cors()`, or restrict it to `http://localhost:5173`. Bind the server to `127.0.0.1`.

### P1-2. UI shows at most 200 companies, with no pagination
Files: `client/src/App.jsx`, `client/src/api.js`.
- **Reproduced:** with 254 rows, `GET /api/companies` returns 200 items against `total: 254`. The UI header says "254 companies" but renders 200, and there is no page control or "load more", so the rest are unreachable unless you filter.
- **Fix direction:** add page controls (the API already supports `page` and `limit`) or increase the limit with virtual scrolling.

### P1-3. "Researched" count and status are inflated
Files: `server/src/lib/research.js` (end of `researchCompany`), `server/src/app.js` (`/api/stats`).
- **Reproduced:** research on example.com found nothing, yet `researchStatus` is `partial`, and `/api/stats` counted it as `researched`. `found >= 2 ? 'researched' : 'partial'` never yields a "nothing found" state.
- **Fix direction:** add a `nothing_found` status (or use `partial` only when `found >= 1`) and count only `researched` and `partial` with findings in the dashboard.

### P1-4. "Follow-up date" sort puts empty dates first
File: `server/src/lib/filters.js` (`SORTS.followUp`).
- **Reproduced:** `?sort=followUp` returned two companies with no follow-up date first. Mongo ascending sort puts nulls first, so the sort is useless once most rows have no date.
- **Fix direction:** sort with an aggregation or computed key that pushes nulls last.

### P1-5. Import is sequential and non-transactional, with possible dedupe collisions
File: `server/src/app.js` (`POST /api/import`).
- **By inspection:**
  - One `findById` per existing row (N+1).
  - A name match is used when the domain is absent, so two different companies with the same name collapse into one.
  - A company whose name matches an existing record but has a different domain is merged into it.
  - Two concurrent imports can insert duplicates, because there is no unique index on `domain`.
  - Re-import only fills blank fields (documented), but `appStatus`, `fundingStatus` and `fundingStage` from the file are never applied to existing rows.
- **Fix direction:** a partial unique index on `domain` (where non-empty), batched `bulkWrite`, and clear counts for merges by name.

### P1-6. robots.txt parser is too minimal
File: `server/src/lib/research.js` (`robotsAllows`).
- **By inspection (not executed):**
  - Consecutive `User-agent` lines are mishandled. `User-agent: *` followed by `User-agent: Foo` sets `applies = false` at the second line and loses the `*` group.
  - `Allow:` lines, wildcards (`*`, `$`) and longest-match precedence are ignored.
  - A 4xx/5xx or timeout on robots.txt is treated as "allowed".
- **Fix direction:** use a tested parser library (for example `robots-parser`) and add unit tests. Decide explicitly how to treat 5xx.

### P1-7. Test gaps for the claimed features
- No tests for: routes (import, edit, delete, export), dedupe logic, research orchestration, SSRF guard, robots handling, CSV export (including formula-injection prefixing), stats definitions, and every React component.
- Added only 1 test in this audit (funding normalization).
- **Fix direction:** add `supertest` plus `mongodb-memory-server` (or a scratch DB), and a local HTTP fixture server for research. Add a Playwright smoke test for import, filter, status change and export.

### P1-8. Windows/Docker setup is fragile on this machine
Files: `docker-compose.yml`, `README.md`.
- **By inspection, not executed:** a container named `jobs-mongo` already exists, created manually with `docker run`. `docker-compose.yml` also sets `container_name: jobs-mongo`, so `docker compose up -d` will likely fail with a name conflict, and the port is already bound. Compose would also create a *different* volume (`jobs-portal_jobs-mongo-data`) than the manual one (`jobs-mongo-data`), so data would appear to vanish.
- The README only documents `docker compose up -d`, not this situation.
- **Fix direction:** either remove the manual container and use compose, or document `docker start jobs-mongo`. Consider dropping the fixed `container_name`.

## P2: Nice to fix

1. **Email harvesting is broader than documented.** `findEmails` accepts *any* same-domain address (for example `jane.doe@company.com`), not only role addresses. The README says "public recruiting/contact email". Restrict to role-style local parts or flag personal-looking ones.
2. **Funding column "No" maps to `bootstrapped`.** Whether "No" means bootstrapped or just not known is a judgment call. "Series B+" collapses to `series-b`, and the regex `late` matches words like "template" (reproduced: "Template" becomes `series-c+`).
3. **Race conditions in the UI.** `App.jsx` `refresh` can apply out-of-order responses when filters change quickly. There is no request cancellation.
4. **Dashboard values computed but not shown.** `followUpsDue`, `withRoles` and `offers` come from `/api/stats` but are not shown in the UI. Overdue follow-ups are only highlighted in the table.
5. **Accessibility.** The drawer has no Escape key handling, focus trap or `role="dialog"`. Delete uses `window.confirm`.
6. **Lint warnings (3):**
   - `CompanyTable.jsx:13`: `fmtDate` is exported from a component file, which hurts fast refresh. Move it to a util.
   - `CompanyTable.jsx:20`: `new Date()` is called during render.
   - `App.jsx:50`: `setState` inside the debounce effect.
   None are bugs today.
7. **Role discovery quality.** Titles can have trailing noise like "Learn more" glued on, and "Developer Relations" matches as an engineering role. They are labelled "verify manually" but the filter "Has engineering roles" treats them as `yes`.
8. **No server-side lint, no `engines` field, no CI.** The server has no lint script. Add `"engines": {"node": ">=20"}`.
9. **Missing input limits.** No max length on text fields and no max row count on import beyond the 10 MB file cap.
10. **Unsafe rendering: no issues found.** There is no `dangerouslySetInnerHTML` or `innerHTML` in `client/src`. All `href`s come from URLs normalised to http(s) by `normalizeUrl`, or from research results that are absolute `http(s)` URLs, plus validated `mailto:` addresses. Export prefixes `= + - @` cells to block formula injection (by inspection; not covered by a test).

## What was verified working (reproduced)

- CSV import with dedupe: re-importing the same file inserts 0 and skips duplicates. A CSV with no name column returns a clear 400. A malformed CSV returns a 400 with a parse message.
- Filters (funding stage) and stats counts. Status PATCH persisted. Invalid email and invalid id return 400.
- Persistence: companies live in MongoDB, not in memory.
- Direct private-IP research targets are refused.
- CSV export returns a UTF-8 file with a header row and source columns.

## Next actions (in order)

1. Fix P0-1 (research must not overwrite manual data, and edits must clear stale verification).
2. Fix P0-2 (never silently drop imported values).
3. Fix P0-3 (manual redirect handling with per-hop checks, IPv4-mapped IPv6, robots.txt fetch guard).
4. Fix P1-1 (CORS), then P1-2 (pagination), then P1-3 and P1-4.
5. Add route and research tests with a scratch DB and a local fixture server (P1-7), then a browser smoke test.
6. Resolve the Docker container conflict (P1-8) and update the README.
