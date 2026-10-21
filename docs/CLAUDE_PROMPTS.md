# Claude Code Prompts: run in order

Stack: React + Vite + Tailwind, Node + Express, MongoDB (Mongoose), JavaScript. No Python or Streamlit. Run one prompt at a time and review the result.

1. **Scaffold.** Read `README.md` and `docs/`. Create `server/` (Express, Mongoose, dotenv, cors) and `client/` (Vite React + Tailwind with an `/api` proxy to :4000). Add root scripts `setup`, `dev`, `test`. Read `MONGO_URI` from `server/.env`, with a clear error if Mongo is unreachable. Run it and show the PowerShell commands.
2. **Model + CSV import.** Create the `Company` model per `docs/DATA_MODEL.md`. Implement `POST /api/import` with header alias mapping, URL normalization, dedupe by domain then name, non-destructive updates, unmapped columns kept in `extra`, and counts plus row errors. Add node:test unit tests.
3. **List, search, filters, edit.** Implement `GET /api/companies` with regex-escaped AND filters and sorting, `PATCH` with whitelisted validated fields, and `/api/facets`. Build the table, filter bar, empty state, loading and error states, and the edit drawer.
4. **Status tracking, stats, export.** Inline status select (setting the applied date automatically), notes, follow-up dates, `/api/stats` with the dashboard tiles, and CSV export honouring filters (guard against formula injection).
5. **Website research.** Implement `lib/research.js`: robots.txt, timeouts, size and page caps, private-IP block. Store careers URL, public email and role links only when observed, each with a source URL. Never infer funding. Show a log in the drawer. Test extractors with fixtures.
6. **QA.** Run `npm test` and `npm run build`. Test an empty DB, a malformed CSV, duplicates, invalid URLs and a restart for persistence. Fix issues. Report only what you actually ran.
7. **Real data.** Import my actual sheet export. Inspect its headers, adjust the aliases in `lib/csv.js`, import a small sample first, and do not bulk-research automatically.
