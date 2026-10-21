# Startup Finder

A startup discovery and job-application tracker. Import your Google Sheet as CSV, filter companies, research their public careers pages and contact emails, and track each application.

**Stack:** React + Vite + Tailwind CSS · Node.js + Express · MongoDB (Mongoose) · JavaScript only.

## Quick start (Windows PowerShell)

Prerequisites: Node 20+, and MongoDB (Docker is easiest).

```powershell
cd D:\Projects\Jobs-Portal
npm run setup                      # installs root, server and client deps
docker compose up -d               # starts MongoDB on localhost:27017
Copy-Item server\.env.example server\.env
npm run dev                        # API on :4000, web on http://localhost:5173
```

Open http://localhost:5173, click **Import CSV**, and pick your sheet export (try `sample_startups.csv`).

Run tests: `npm test`. Production build of the UI: `npm run build`.

### Configuring MongoDB (`MONGO_URI`)
Set it in `server/.env`:
- Local Docker (default): `MONGO_URI=mongodb://127.0.0.1:27017/startup-finder`
- Atlas free tier (no Docker needed): create a cluster, add your IP under Network Access, and paste the `mongodb+srv://user:pass@cluster/startup-finder` string.
- Native install: install MongoDB Community, start the service, keep the default URI.

`.env` is git-ignored; never commit credentials.

## Features
| Area | Status |
|---|---|
| CSV import (auto column mapping, dedupe by domain/name, unmapped columns preserved) | Done |
| Dashboard: total, researched, applications sent, replies, interviews | Done |
| Search + filters: funding, stage, location, industry, engineering roles, status, research | Done |
| Status tracking (Not Applied → Offer), notes, applied/follow-up dates, contact details | Done |
| Edit/delete companies, CSV export (respects current filters) | Done |
| Website research: careers page, public email, engineering-looking role links, with source URLs | Done, best-effort |
| Funding verification | **Manual only.** You enter status, stage and source URL, then tick "verified" |
| Role discovery on JS-rendered or ATS-only career pages | Not done; shows "unknown" |
| Browser-tested UI | Compiled and served by Vite; not exercised in a real browser during the build |

## Honesty rules
- Research only stores values it actually saw on a fetched page, together with the source URL. Nothing is guessed or invented.
- Careers URLs are saved only if the link was seen on the homepage **and** the page loaded.
- Funding is never inferred. CSV-imported funding is shown as "(unverified)" until you verify it.
- "Engineering roles" from research is a text match on links. It is a lead, not proof.
- Research fetches at most 4 pages per company, only on click, honours `robots.txt`, uses a descriptive User-Agent, blocks private IP ranges, and never bypasses logins or CAPTCHAs.
- No emails are ever sent.

## CSV format
Required column: `Company Name` (aliases: Company, Name, Startup). Optional, auto-detected: Website, Location, Industry, Funding Stage, Funding Status, Careers, Email, Notes, Status. Other columns are kept in `extra`. Re-importing never overwrites edits; it only fills blank fields.

See `docs/` for architecture, data model, build plan and Claude Code prompts.
