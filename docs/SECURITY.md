# Security and data quality

Startup Finder is a **single-user tool you run on your own computer**. It has no login. The protections below assume that model. Passing the tests does **not** make it safe to put on a network or the internet (see "Residual risks").

## What is enforced

| Area | Protection | Where |
|---|---|---|
| Network exposure | API listens on `127.0.0.1` only (override with `HOST`). MongoDB in `docker-compose.yml` is published on `127.0.0.1` only. | `src/index.js`, `docker-compose.yml` |
| DNS rebinding | Requests whose `Host` is not `localhost`, `127.0.0.1` or `::1` get 403 (`ALLOWED_HOSTS` to change). | `middleware/security.js` |
| Cross-site requests | Browser requests from any other origin get 403; CORS allows only `http://localhost:5173` and `http://127.0.0.1:5173` (`CORS_ORIGINS` to change), never `*`, no credentials. | `middleware/security.js` |
| Response hardening | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store`; no `X-Powered-By`; every unknown path returns a JSON 404. | `middleware/security.js` |
| Rate limits (per client address, in memory) | all API calls 600/min; start research 20/min; batch research 5/min; CSV preview+import 20 per 10 min; drafting 60/min; AI drafts 10 per 10 min. Over the limit: 429 with `Retry-After`. | `middleware/security.js`, `lib/outreachService.js` |
| Request size and time | JSON 1 MB; CSV 10 MB / 20,000 rows; one file and at most 8 small form fields per upload; HTTP request timeout 60 s, headers 15 s. | `app.js`, `index.js`, `lib/csvParse.js` |
| Input validation | Every write endpoint whitelists fields and checks types, lengths, URLs, emails, dates and enums. Objects/arrays where text is expected (e.g. `{"$ne": ...}`) are refused with 400 and change nothing. Query strings never build query operators; search text is regex-escaped and capped. | `cleanPatch`, `lib/applications.js`, `lib/outreach.js`, `lib/filters.js` |
| Own-property lookups | User text is never used to index plain objects (`?sort=constructor` and a CSV column called `constructor` used to break things). | `lib/filters.js`, `lib/importer.js` |
| SSRF (website research) | Only http/https on ports 80/443, no credentials in URLs, no internal-looking names; DNS is validated inside the connection so every address must be public and that same answer is used; every redirect hop is re-validated and off-site redirects are refused; response size, time, page and request caps; per-host spacing; robots.txt honoured. | `lib/urlSafety.js`, `lib/safeFetch.js`, `lib/researchRun.js` |
| XSS | React escapes all text. No `dangerouslySetInnerHTML`. Links are rendered only for `http(s)` URLs that were normalised server-side; external links use `rel="noopener noreferrer"`. API responses are JSON/CSV with `nosniff`. | `client/src` |
| CSV formula injection | Exported cells (and header names) starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; stored values are untouched and the importer removes the prefix. Same for the error CSV. | `lib/exportCsv.js`, `routes/applications.js`, `client/src/importCsv.js` |
| Secrets | API key only in `server/.env` (git-ignored); never in the frontend, responses or logs (provider errors are reduced to a short code); connection strings are masked before printing; `.env.example` has an empty key; a test scans the repo for key-shaped text. | `lib/outreachAi.js`, `lib/mask.js` |
| Error responses | 5xx returns only `Internal server error`; validation, cast, upload and parser errors become short generic messages (no model names, paths, stack traces or connection strings). | `middleware/security.js` |
| Duplicates and partial work | One import writes at a time (409 otherwise); research has a per-company lock; applications have unique indexes; saving an identical draft twice returns the first; a database failure mid-import reports how many rows were saved and says re-running is safe. | `routes/importExport.js`, `lib/researchService.js`, `models/Application.js` |
| Consistency | `npm --prefix server run check:integrity` compares companies, applications and drafts (add `-- --repair` to recompute summaries and clear dangling draft links). It **never deletes**: orphans are listed for you to decide. The server also runs it at start and warns. | `lib/integrity.js` |
| Dependencies | `npm audit` run on the root, `server` and `client`: see below. Lockfiles are committed. | |

## Settings

`server/.env` (all optional): `HOST` (default `127.0.0.1`), `ALLOWED_HOSTS`, `CORS_ORIGINS`, `ANTHROPIC_API_KEY`, `OUTREACH_AI`, `OUTREACH_AI_MODEL`, `RESEARCH_ROLE_KEYWORDS`. Don't widen `HOST`, `ALLOWED_HOSTS` or `CORS_ORIGINS` unless you also add authentication.

## Verification
- `npm test`: server tests, including `security.test.js` (no database) and `security-api.test.js` (real MongoDB test database). Each protection above was also mutation-checked: switching it off makes at least one test fail.
- Reproduced before fixing and now covered: server reachable from the LAN, `Host: evil.example` accepted, `Access-Control-Allow-Origin: *`, 900 KB text fields accepted, no multipart field limits, verbose Mongoose errors, HTML 404 page, `X-Powered-By`, `__proto__` CSV header losing data, `?sort=constructor` returning 500, a CSV column named `constructor` breaking import, a bulk finding action accepted before validation, formula-like CSV *headers* not guarded, MongoDB published on all interfaces.

## Residual risks (not fixed)
- **No authentication.** Anyone or anything that can reach `127.0.0.1:4000` on your machine can read and change all data (other local users, malware, a browser extension). The host/origin checks only stop *other websites*. If you ever host this, you must add login, HTTPS and per-user data first.
- **MongoDB has no password.** It is bound to localhost, but local processes can still use it. Use a password-protected Atlas cluster or enable Mongo auth for anything beyond a personal machine.
- **The container I recreated binds to localhost; an existing container you made yourself may not.** Check with `docker port jobs-mongo`: it should show `127.0.0.1:27017`.
- **Frontend pages have no Content-Security-Policy.** Vite's dev server needs inline scripts. If you serve the built `client/dist`, add a CSP and security headers at that web server.
- **Rate limits are per process and per IP.** They reset on restart and, because every local request comes from `127.0.0.1`, they act as a global limit, not a per-user one.
- **Outbound requests are by design.** Research fetches third-party websites you list; with an API key set, drafting sends the displayed facts and your background to Anthropic. Public-address checks rely on the OS resolver.
- **Formula-injection guard is Excel-oriented.** The leading `'` is the standard mitigation; other spreadsheet programs may show it. Never open exports in a tool that auto-executes formulas or DDE.
- **AI output validation is heuristic.** It rejects unsupported numbers, links, emails, funding claims and attachment mentions, but cannot judge tone or subtle falsehoods. You review every draft before sending it yourself.
- **Mongoose 9 prints a deprecation warning for `validateSync`.** Not a security issue; the import planner should be moved to async validation before Mongoose 10.
- **`npm audit` is a point-in-time check** of known advisories. Nothing monitors new ones automatically; re-run it periodically.
- **Imports hold the file and existing companies in memory** (bounded by the 10 MB / 20,000-row limits).
