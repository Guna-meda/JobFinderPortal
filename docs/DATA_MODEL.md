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
| appStatus, appStatuses, applicationCount | summary | **maintained by the server** from the Application records: furthest-along status, every status present, number of applications |
| appliedDate, followUpDate, lastContactDate | Date | summary: earliest applied date, earliest follow-up of open applications, latest contact |
| notes | String | |
| extra | Mixed | unmapped CSV columns |

Dashboard definitions (counted over **applications**): *applied* = Applied + Replied + Interview + Rejected + Offer; *replies* = Replied + Interview + Offer; *researched* = a research run completed (researched, partial or not_found; failed and running don't count).

## Finding (subdocument of `findings`)
`kind` (careers/email/role/website/funding), `value` (URL, email, or the quoted funding sentence), `title` (roles), **`sourceUrl`** (the page it was seen on), **`observedAt`**, `basis` (official-link, official-page-mailto, official-page-text, keyword-match, company-statement, redirect), `confidence` (verified = seen directly on an official-site page; inferred = keyword/text lead; unverified = weak or company-claim only), `evidence`, `meta` (matched keywords; funding stage/amount/date as literally stated), `status` (pending/accepted/rejected), `decidedAt`, `seenInLatestRun`. Re-runs refresh `observedAt` and keep decisions; findings not seen again are flagged, never deleted. "Stale" means observed more than 90 days ago.

## Application (collection `applications`)
`company` (ref), `role` ('' = general application), `roleKey` (normalised role), `jobUrl`, `jobUrlKey` (normalised), `status`, `appliedDate`, `lastContactDate`, `followUpDate`, `contactName`, `contactEmail`, `contactUrl`, `nextAction`, `notes`, `history` [{at, type: created/status/applied/followUp/contact/details/note/migrated, summary, from?, to?}], `createdAt`, `updatedAt`. Unique indexes: (company, roleKey) and (company, jobUrlKey) when a URL is present. Dates are stored as UTC midnight of the calendar date. Overdue = follow-up before today on an application that is not Rejected/Offer.

## Draft (collection `drafts`)
`company`, `application` (optional), `purpose` (internship_inquiry, role_application, recruiter_follow_up, job_listing_response), `role`, `subject`, `body`, `generatedBy` (template/ai/manual), `facts` [{key, label, value, basis: verified/record/you, source?}], `status` (draft/sent), `sentAt` (set only when you mark it sent), timestamps. At most 50 per company. Deleting a company deletes its drafts.
