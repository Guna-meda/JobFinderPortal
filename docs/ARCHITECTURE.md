# Architecture

```
React + Vite + Tailwind  --/api proxy-->  Express  -->  MongoDB
   client/ (:5173)                         server/ (:4000)
```

## Server (`server/src`)
- `index.js`: loads `.env`, connects to MongoDB (clear error and exit if unreachable), starts Express.
- `app.js`: all routes, input validation (`cleanPatch` whitelists and validates editable fields), error middleware.
- `models/Company.js`: Mongoose schema.
- `lib/csvParse.js`: strict CSV parsing (UTF-8/BOM, delimiter sniffing, limits). Malformed input throws `ImportError`.
- `lib/importer.js`: aliases, mapping validation, row normalisation, duplicate matching, merge rules, `planImport` (pure, no DB).
- `lib/exportCsv.js`: export columns, formula guard, extra columns.
- `routes/importExport.js`: preview / import / export routes.
- `models/Application.js`: one application per role (unique per company+role and company+job URL); embedded activity history.
- `lib/applications.js`: pure rules (validation, status transitions, history, rollup, overdue).
- `lib/applicationService.js`: persistence, duplicate checks, company summary, legacy compatibility, migration.
- `routes/applications.js`: application routes and CSV export.
- `scripts/migrate-applications.js`: optional manual migration.
- `lib/csv.js`: URL, domain and funding normalisers.
- `lib/filters.js`: query-string to Mongo filter (regex-escaped, all filters ANDed) and sort map.
- `config/research.js`: limits, user-agent, role keywords (env `RESEARCH_ROLE_KEYWORDS`).
- `lib/urlSafety.js`: URL validation, blocked IP/hostname rules, site matching.
- `lib/safeFetch.js`: SSRF-safe fetcher (DNS validated inside the connection, manual redirects, timeouts, size cap, per-host rate limit).
- `lib/researchExtract.js`: pure HTML extraction (links, roles, emails, funding leads).
- `lib/researchRun.js`: one bounded research pass producing findings (robots.txt, page/request caps, safe errors).
- `lib/findings.js`: reconciling findings across runs; applying an accepted finding without overwriting existing values.
- `lib/researchService.js`: per-company lock, worker pool, persistence, accept/reject.
- `routes/research.js`: research and finding routes.

### API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/companies?q&fundingStatus&fundingStage&location&industry&hasRelevantRoles&appStatus&researchStatus&sort&page&limit` | list + filter |
| POST/PATCH/DELETE | `/api/companies[/:id]` | create / edit / delete |
| POST | `/api/companies/:id/research` | start research (202, runs in background; 409 if already running) |
| POST | `/api/research/batch` `{ids}` | queue research for up to 25 companies |
| POST | `/api/companies/:id/findings/:fid` `{action: accept, reject or reset; value?; overwrite?}` | decide a finding (409 `conflict` unless overwrite) |
| POST | `/api/companies/:id/findings` `{action, ids}` | decide several findings |
| GET | `/api/research/config` | keywords and limits shown in the UI |
| POST | `/api/import/preview` (multipart `file`) | parse + suggested column mapping; writes nothing |
| POST | `/api/import` (multipart `file`, `mapping`, `policy`, `decisions`, `dryRun`) | dry-run plan or apply; returns created/updated/skipped/failed/possibleDuplicates, reasons, warnings, failed rows |
| GET | `/api/export?...same filters` | CSV download |
| GET/POST | `/api/companies/:id/applications` | list / add an application (409 on duplicates) |
| PATCH/DELETE | `/api/applications/:id` | edit (status, dates, contact, notes…) / delete |
| POST | `/api/applications/:id/activity` `{note}` | add a manual history entry |
| GET | `/api/applications?status&followUpDue&limit` | applications across companies (follow-ups due) |
| GET | `/api/applications/export` | applications CSV |
| GET | `/api/stats`, `/api/facets` | dashboard numbers (application based), filter options |

## Client (`client/src`)
`App.jsx` holds filters/data state (250ms debounced search). Components: `Stats`, `CompanyTable` (inline status change), `EditDrawer` (edit, funding, research results), `ImportButton`. `api.js` wraps fetch with friendly errors.

## Data principles
- Imported/edited data and researched data are kept separate. Researched values carry `*SourceUrl` and `*Verified` flags.
- Research never touches funding fields.
- Import is non-destructive: existing records only get blank fields filled.
- CSV export prefixes cells starting with `= + - @` to prevent spreadsheet formula injection.
- Secrets live only in `server/.env`.

## MongoDB fallback
If Docker/local Mongo is a blocker, use a free MongoDB Atlas cluster and set `MONGO_URI`. No code changes are needed.
