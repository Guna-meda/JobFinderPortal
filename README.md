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

Run tests: `npm test` (the API tests use the separate database `startup-finder-test` on your local MongoDB, via `MONGO_TEST_URI` if you want another one, and are skipped with a warning if MongoDB is unreachable). Production build of the UI: `npm run build`.

### Configuring MongoDB (`MONGO_URI`)
Set it in `server/.env`:
- Local Docker (default): `MONGO_URI=mongodb://127.0.0.1:27017/startup-finder`
- Atlas free tier (no Docker needed): create a cluster, add your IP under Network Access, and paste the `mongodb+srv://user:pass@cluster/startup-finder` string.
- Native install: install MongoDB Community, start the service, keep the default URI.

`.env` is git-ignored; never commit credentials.

## Features
| Area | Status |
|---|---|
| CSV import wizard: column mapping, dry-run review, duplicate policy, error CSV, protected application data | Done (see "CSV import") |
| Dashboard: total, researched, applications sent, replies, interviews | Done |
| Search + filters: funding, stage, location, industry, engineering roles, status, research | Done |
| Status tracking (Not Applied → Offer), notes, applied/follow-up dates, contact details | Done |
| Edit/delete companies, CSV export (respects current filters) | Done |
| Website research: evidence-backed findings (careers page, public email, role leads, funding statements) with per-finding sources; accept/edit/reject; single and batch; SSRF-hardened | Done, best-effort (see "Website research") |
| Funding verification | Research can surface the company's own funding statement as an unverified lead; **independent verification is manual** (source URL + "verified" tick) |
| Role discovery on JS-rendered or hiring-platform-only career pages | Not done; shows "not detected" |
| Browser-tested UI | Compiled and served by Vite; not exercised in a real browser during the build |

## Honesty rules
- Research only proposes values it actually saw on a fetched page, each with its own source URL and observation time. Nothing is guessed or invented, and nothing is applied until you accept it.
- "Not detected" never means "does not exist". Role matches are leads, not proof. Funding is never inferred: a company's own statement is recorded as unverified, and CSV-imported funding shows "(unverified)" until you verify it.
- Research is polite and bounded (see "Research safety"), blocks private/internal addresses, and never bypasses logins, CAPTCHAs or robots.txt.
- No emails are ever sent and no applications are made automatically.

## Website research
Open a company and press **Run research** (or tick several rows and press **Research selected**, max 25). Research runs in the background; the row and drawer show progress, and you can retry any failure later. **Nothing is written to the company until you accept a finding.**

**What it reads:** the company's own website only. Starting from the supplied URL it reads `robots.txt`, the homepage, and then at most 5 more same-site pages chosen from obvious links: Careers/Jobs, Contact, About, Team, Press (6 pages and 10 requests per company in total). It never guesses URLs, follows links to other sites, logs in, solves CAPTCHAs, decodes obfuscated emails, or runs JavaScript.

**What it proposes (each a *finding* with its own source URL and observation time):**
| Finding | How it is found | Confidence label |
|---|---|---|
| Careers page | a link on the official site; the page was fetched | `verified` (page loaded); `unverified` if the linked page failed to load; `inferred` if it is only a link to a hiring platform (not fetched) |
| Public email | `mailto:` or visible text on a fetched page, **role-style addresses on the company's own domain only** (careers@, jobs@, hr@, hello@, info@ …). Personal-looking addresses are never stored | `verified` (publicly listed on that page) |
| Role leads | careers-page links whose text matches the configurable keyword list (default includes engineer, developer, backend, AI, ML, SRE, intern …; override with `RESEARCH_ROLE_KEYWORDS`) | `inferred`: a lead, not proof that the job is open or right for you |
| Funding statement | a sentence on the company's own pages about raising money; stage/amount/date are taken only if literally in the sentence | `unverified`: the company's own claim |
| Website | the homepage redirects to another site (not followed) | `unverified` |

*Verified* means "observed directly on an official-site page at that time", not "independently confirmed". **Missing items mean "not detected", never "does not exist"** (no email found is not the same as no contact email; no careers link is not the same as not hiring; no role links is not the same as no jobs, because many job boards load via JavaScript, which is not read). Findings older than 90 days are shown as *stale*; findings missing from the latest complete run are marked *not re-observed*.

**Reviewing:** each finding shows its source link (opens in a new tab), basis, confidence and evidence. You can **Accept**, **Edit then accept**, or **Reject**. Rejected findings are not proposed again. If accepting would replace a value that is already there (typed by you, or verified funding), the existing value is kept and you are asked to confirm the replacement; research itself never overwrites anything. Accepting a funding statement records the company's claim with its source but does **not** mark funding verified. An accepted careers/email value keeps its source and `verified` flag only if you didn't edit it; hand-editing a field clears its research source.

### Research safety
- **SSRF:** only `http`/`https`, standard ports (80/443), no credentials in URLs, no internal-looking hostnames (`localhost`, `*.local`, `*.internal`, cloud metadata names, single-label hosts). DNS is validated **inside the connection itself**: every resolved address must be public (loopback, private, link-local, CGNAT, multicast, reserved, and IPv4-mapped/NAT64/6to4 IPv6 forms are blocked) and the socket connects to that same validated answer, so there is no rebinding window. Redirects are followed manually (max 3), each hop fully re-validated, and redirects to another site are refused.
- **Limits:** 8 s timeout per request, 1 MB per response (identity encoding only), 45 s per company, at least 1 s between requests to the same host (more if robots.txt asks via Crawl-delay), at most 2 companies researched at once, one run per company at a time (a second request gets 409).
- **robots.txt** (parsed with `robots-parser`, honouring Allow/Disallow precedence, our user-agent group and Crawl-delay): a disallowed page is not fetched; a server error reading robots.txt stops research with a retryable error; a missing robots.txt means no restrictions.
- Errors shown in the UI are fixed, safe messages with a stable code and a retry hint. They never include IP addresses, stack traces or internal details (those go to the server log only).

### Research limitations (best-effort)
- Only pages the homepage links to are read, so a careers page linked only from a JavaScript menu, or a site that is a single-page app, may show "not detected".
- Hiring-platform boards (Lever, Greenhouse, Ashby …) are recorded as a link but not read, so their roles aren't listed.
- Role titles come from link text and can include noise or false matches. Sites that block bots (403/429) fail with a clear message instead of being bypassed.
- Funding is only what a company says about itself; there is no independent funding source integration. Treat it as a lead and verify elsewhere.
- Findings and their evidence are stored in the database but are not part of CSV export/import (accepted values and their source URLs are).
- Homepages larger than 1 MB are truncated (noted in the run log), which can hide links near the end.
- The research UI has not been exercised in a real browser in this environment (the extension was unavailable); the API, run logic, security rules and the frontend build are covered by tests.

## CSV import
**Import CSV** opens a four-step wizard: **Upload → Map columns → Review → Done**. Nothing is written until you press *Import now* on the review step.

1. **Upload**: `.csv` only, UTF-8 (a BOM is fine), up to 10 MB / 20,000 rows. Comma, semicolon and tab delimiters are detected. Quoted fields, `""` escapes, embedded commas and newlines are handled by a real CSV parser. A malformed file (unterminated quote, binary data, not UTF-8, empty, header only) is rejected as a whole with a message, so it can never half-apply.
2. **Map columns**: headers are matched automatically (Company, Startup, Company Name, Website, URL, Funding, Funding Stage, Industry, Location, Careers, Email, Job Title, Notes, Application Status, dates, and every column this app exports). For each column you can pick a field, *Keep as extra data* or *Ignore*. A bare `Status` column is only auto-mapped to application status if every value is a valid status. A company-name column is required.
3. **Review**: a dry run shows what will be created, updated, skipped and failed, a sample of parsed rows, possible duplicates with the reason, and value warnings. You choose the duplicate policy (skip or update) and can override each flagged row (skip / update existing / create new). Failed rows can be downloaded as an error CSV (original columns plus `Row` and `Error`).
4. **Done**: final counts. Nothing about your filters or existing application data is reset.

### What counts as a duplicate
Matching uses the normalised website domain (`https://www.Acme.io/x` → `acme.io`) and a normalised company name (case, punctuation and legal suffixes like Inc/Ltd ignored). Shared hosts (linkedin.com, github.io, notion.site, …) are never used as identity.
- Same domain, or same name where one side has no website → treated as the same company; the policy decides (default skip).
- Same name but **different** websites → flagged as a *possible duplicate* and created as a separate company unless you choose otherwise.
- Merely similar names (`Acme` vs `Acme Labs`) are never merged or flagged.
- Duplicates within the same file are detected too. Importing the same file twice creates nothing.

### What "update" may change
Blank CSV cells never change anything. Notes, application status, applied/follow-up dates, contact name, URLs and research fields are only **filled when empty**. Location, industry and *unverified* funding status/stage can be overwritten by a different non-blank value. Verified funding is never touched and company names never change. Roles and extra columns are added, never removed.

### Values that can't be used
An invalid website/email/URL, unrecognised status, free-text funding such as "Yet to raise", or a non-ISO date is **not dropped and not guessed**: the raw text is kept under `<Column> (original)` in the company's extra data and listed as a warning. Funding is never inferred from free text. Dates must be `YYYY-MM-DD` (ISO); `03/04/2026` is ambiguous and is not guessed. **Job Title** is stored as an unverified role in the company's role list; it does not set "Has engineering roles".

## CSV export
**Export CSV** downloads the currently filtered list (UTF-8 with BOM, Excel-friendly). Columns: company, website, location, industry, funding status/stage/source/verified, careers URL/source/verified, contact email/source/name, relevant roles, open roles, research status/time, application status, applied date, follow-up date, notes, plus any extra columns. Cells starting with `=`, `+`, `-`, `@` get a leading `'` in the file only (the stored value is unchanged), and the importer removes it again. Every exported header is understood by the importer, so an export re-imports cleanly (verified by tests, including with an empty database).

### Import/export limitations
- No progress bar: the import is a single request (in tests, a 3,000-row import plus an identical re-import took about 1 second together); the wizard shows a busy message.
- No database transaction (standalone MongoDB). The whole plan is validated before any write, but a database failure mid-way can leave a partial import; re-running the same file is safe because already-imported rows are detected as duplicates.
- No unique index on domain, so two imports running at the exact same moment could both create a company.
- A `)` inside a role URL is exported as `%29` (same URL, different spelling).
- Encodings other than UTF-8 and `.xlsx` files are rejected, not converted.
- The wizard UI has not been exercised in a real browser in this environment (the browser extension was unavailable); the API, the planner and the error-CSV builder are covered by automated tests and the frontend production build passes.

See `docs/` for architecture, data model, build plan and Claude Code prompts.
