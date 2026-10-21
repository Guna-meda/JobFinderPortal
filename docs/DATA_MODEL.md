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
| openRoles | `[{title, url}]` | text-matched links from the careers page |
| researchStatus | `not_researched` / `researched` / `partial` / `failed` | |
| researchedAt, researchLog | Date, [String] | log explains what was and wasn't found |
| appStatus | Not Applied, To Apply, Applied, Replied, Interview, Rejected, Offer | indexed |
| appliedDate, followUpDate | Date | |
| notes | String | |
| extra | Mixed | unmapped CSV columns |

Dashboard definitions: *applied* = Applied + Replied + Interview + Rejected + Offer; *replies* = Replied + Interview + Offer; *researched* = researched or partial.
