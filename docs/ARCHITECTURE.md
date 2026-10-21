# Architecture

```
React + Vite + Tailwind  --/api proxy-->  Express  -->  MongoDB
   client/ (:5173)                         server/ (:4000)
```

## Server (`server/src`)
- `index.js`: loads `.env`, connects to MongoDB (clear error and exit if unreachable), starts Express.
- `app.js`: all routes, input validation (`cleanPatch` whitelists and validates editable fields), error middleware.
- `models/Company.js`: Mongoose schema.
- `lib/csv.js`: header mapping, URL/funding/status normalization, `parseCompanies` (pure, no DB).
- `lib/filters.js`: query-string to Mongo filter (regex-escaped, all filters ANDed) and sort map.
- `lib/research.js`: polite website research (robots.txt, 8s timeout, 1MB cap, 4-page cap, SSRF guard).

### API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/companies?q&fundingStatus&fundingStage&location&industry&hasRelevantRoles&appStatus&researchStatus&sort&page&limit` | list + filter |
| POST/PATCH/DELETE | `/api/companies[/:id]` | create / edit / delete |
| POST | `/api/companies/:id/research` | run website research |
| POST | `/api/import` (multipart `file`) | CSV import, returns counts |
| GET | `/api/export?...same filters` | CSV download |
| GET | `/api/stats`, `/api/facets` | dashboard numbers, filter options |

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
