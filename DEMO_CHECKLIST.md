# Demo checklist

Every step and number below was run in a real browser against the sample files (`npm run ui-check`, 45 checks). Button names are exactly what is on screen.

## 0. Before you start (2 minutes)

Use a **separate demo database** so your real data is never touched. In PowerShell:

```powershell
cd D:\Projects\Jobs-Portal
# 1. Open Docker Desktop and wait until it says it is running, then:
docker start jobs-mongo
docker port jobs-mongo                      # must say 127.0.0.1:27017

# 2. Start the app on a fresh demo database (the variable only affects this window):
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/startup-finder-demo'
npm run dev
```

Check in a second window or the browser:

| Check | Expected |
|---|---|
| http://localhost:4000/api/health | `{"ok":true,"db":true,"database":"startup-finder-demo"}` (if it says `startup-finder`, stop and restart with the variable set) |
| http://localhost:5173 | "Startup Finder", dashboard with zeros, **"No companies yet"** |
| Internet | Needed only for the research step. No internet: skip step 6. |

**Reset between runs** (demo database only): stop the app (`Ctrl+C`), then
`docker exec jobs-mongo mongosh startup-finder-demo --eval "db.dropDatabase()"`, then start again.

## 1. The 3-minute demo

| Time | Do this (click-by-click) | Say / show |
|---|---|---|
| 0:00 | Show the empty dashboard. | "A personal tracker for startup applications: discovery, research, tracking, outreach. Local only, nothing is ever sent automatically." |
| 0:20 | **Import CSV** → **Select file** → choose `sample_startups.csv`. | Step 2 "Map columns": columns were matched automatically; you can remap or ignore any. |
| 0:35 | **Review import**. Point at *Will create 12*. Click **Import now**, then **Close**. | "A dry run first: nothing is saved until I confirm." Dashboard now shows **12 companies**. |
| 0:55 | Type `linear` in the search box, then clear it. Choose **Location → India** (shows Northwind Robotics), then clear. Click the **Applied** chip (empty result with "Clear filters"), then **All**. | Search + filters + quick status chips. |
| 1:10 | **Import CSV** → `sample_startups_messy.csv` → **Review import**. | Point at: *Will create 5, skip 2, Failed rows 1, Possible duplicates 3*; the reason for each duplicate; "Missing company name" with **Download error CSV**; the "2 value warnings" (kept, not lost). Change row 9 to **Skip** and back to **Create new**. **Import now** → **Close** → **17 companies**. |
| 1:50 | Click **Linear**. **Add application** → role `Backend Intern`, status *To Apply*, follow-up date 3 days ago → **Add**. **Add application** → `AI Engineer Intern`, status *Applied* → **Add**. | Two roles, two statuses. The **"1 follow-up due (1 overdue)"** banner appears at the top. Try adding `backend intern` again: refused as a duplicate. Change *Backend Intern* to **Interview**; open it to show the activity history. |
| 2:25 | Scroll to **Website research** → **Run research** (about 10–20 s). | Findings each have a **source ↗** link and a label (verified / inferred / unverified). Click **Accept** on the careers page: the Careers URL fills in with its source. "Nothing changes until I accept." |
| 2:45 | Scroll up to **Outreach drafts** → **Write a draft** → purpose *Role application*, role `Backend Intern`, your name → **Generate from template**. Open **Facts used**. Click **Copy body**. | A short email from your real background and labelled facts only; never funding or invented numbers. **Save draft**, then **I sent this** only records that *you* sent it. |
| 2:55 | Close the drawer. Click **Export CSV**. | "Filtered export; formula-safe; re-importable. The app never sends email or applications." |

## 2. Optional extras (if there is time)

- **Failure handling:** open **Northwind Robotics** → **Run research** → "The website domain could not be found" with a **Retry** button. The site's answer is never bypassed.
- **Missing information is asked for:** in *Outreach drafts*, choose *Role application*, leave the role empty → **Generate from template** → it asks for the role instead of guessing.
- **Multiple roles on the table:** the *Linear* row shows "Interview · 2 roles"; the **Follow-up due** chip filters to it.
- **Persistence:** reload the page. Everything is still there (it lives in MongoDB).
- **Applications export:** **Export applications CSV** (one row per role, with activity).
- **Phone layout:** make the browser narrow (or use device mode): the table scrolls inside its box and the drawer fits the screen.
- **Database outage:** `docker stop jobs-mongo` → the app shows an error immediately; `docker start jobs-mongo` → it recovers by itself within seconds.

## 3. Using your real spreadsheet

Your Google Sheet link is private, so the app can't fetch it: in Sheets choose **File → Download → Comma-separated values (.csv)**, then **Import CSV** in the app. The mapping step shows how each of your columns will be imported (change any dropdown, or pick *Keep as extra data* / *Ignore*). Do this on the **real** database (without `MONGO_URI` set) when you want to keep the data, or on the demo database to rehearse. Re-importing the same file is safe: duplicates are detected.

## 4. If something goes wrong

| Problem | Do |
|---|---|
| Page says "Cannot reach the API" | `npm run dev` isn't running (or crashed). Restart it. |
| App won't start, "Could not connect to MongoDB" | Docker Desktop isn't running: open it, wait, `docker start jobs-mongo`. |
| Research is slow or fails | Sites can be slow or block bots. Skip it, or show the failure + **Retry** (step 2). |
| "Generate with AI" is greyed out | Normal: no API key is configured, templates are used. |
| Wrong data on screen | You are on the wrong database. Check `/api/health` (`database`). |
| Browser shows an old version | Hard refresh (`Ctrl+F5`). |

## 5. Safe to say in the demo (and what not to claim)

- It never sends email, contacts anyone, or applies for jobs. "I sent this" only records that you did.
- Research reports what a company's own website shows, with sources. It can miss things; "not detected" is not "doesn't exist".
- Funding is never inferred. A funding statement from the company is shown as an unverified lead.
- Don't claim the AI drafting was tested live (it was tested with a stand-in service), or that it is safe to put on the internet (it has no login).
