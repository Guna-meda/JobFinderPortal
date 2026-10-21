# Data Model

MongoDB collection `companies` (Mongoose model `Company`, timestamps on).

| Field | Type | Notes |
|---|---|---|
| name | String, required | |
| website, domain | String | domain = normalized host, used for dedupe |
| location, industry | String | |
| fundingStatus | `unknown` / `bootstrapped` / `funded` | default `unknown`; manual or imported only |
| fundingStage | `unknown` / `pre-seed` / `seed` / `series-a` / `series-b` / `series-c+` / `other` | |
| fundingSourceUrl, fundingVerified | String, Boolean | user-supplied evidence |
| careersUrl, careersSourceUrl, careersVerified | String, String, Boolean | verified = found and loaded by research |
| contactEmail, contactEmailSourceUrl, contactName | String | source URL is set only when research found the email |
| hasRelevantRoles | `unknown` / `yes` / `no` | |
| openRoles | `[{title, url, sourceUrl?, observedAt?}]` | roles you accepted (or imported) |
| findings | `[Finding]` | researched evidence awaiting review; see below |
| fundingAmount, fundingDate | String | free text, e.g. `$3M`, `May 2024` |
| researchStatus | `not_researched` / `running` / `researched` / `partial` / `not_found` / `failed` | partial = some pages could not be read; not_found = read OK, nothing detected |
| researchError | `{code, message, retryable}` | safe, user-facing |
| researchStartedAt, researchProgress, researchNotFound, researchPages | | run bookkeeping; notFound lists `careers`/`email`/`roles` not detected |
| researchedAt, researchLog | Date, [String] | log explains what was read and what was skipped |
| appStatus | Not Applied, To Apply, Applied, Replied, Interview, Rejected, Offer | indexed |
| appliedDate, followUpDate | Date | |
| notes | String | |
| extra | Mixed | unmapped CSV columns |

Dashboard definitions: *applied* = Applied + Replied + Interview + Rejected + Offer; *replies* = Replied + Interview + Offer; *researched* = a research run completed (researched, partial or not_found; failed and running don't count).

## Finding (subdocument of `findings`)
`kind` (careers/email/role/website/funding), `value` (URL, email, or the quoted funding sentence), `title` (roles), **`sourceUrl`** (the page it was seen on), **`observedAt`**, `basis` (official-link, official-page-mailto, official-page-text, keyword-match, company-statement, redirect), `confidence` (verified = seen directly on an official-site page; inferred = keyword/text lead; unverified = weak or company-claim only), `evidence`, `meta` (matched keywords; funding stage/amount/date as literally stated), `status` (pending/accepted/rejected), `decidedAt`, `seenInLatestRun`. Re-runs refresh `observedAt` and keep decisions; findings not seen again are flagged, never deleted. "Stale" means observed more than 90 days ago.
