# One-hour Build Plan (JavaScript stack)

Priorities and status:

| Pri | Scope | Status |
|---|---|---|
| P0 | App runs, CSV import, list, search + filters, status + notes persist, CSV export | Done |
| P1 | Dashboard stats, edit company records | Done |
| P2 | Website research: careers page, public email, sources | Done (best-effort) |
| P3 | Funding verification, job-opening discovery | Funding manual only; role discovery is a simple link text match |

Suggested time boxes: 0–10 scaffold + Mongo · 10–25 model, import, list API · 25–40 UI table, filters, drawer · 40–50 stats, export, research · 50–60 tests, README, polish.

Cut order if behind: research, then stats, then editing. Never cut persistence, import, filters, status or export.

Next steps: Browser-level UI tests, pagination UI (API supports it), ATS API integrations (Greenhouse/Lever public JSON) for reliable roles, funding lookup via a legitimate API with citations.
