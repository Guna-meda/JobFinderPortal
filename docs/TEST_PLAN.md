# Test Plan

Automated (`npm test`, node:test, no DB needed) in `server/test/csv.test.js`:
- URL/domain normalization; funding normalization never invents funding
- CSV parsing: header mapping, unmapped columns, bad rows, missing name column
- Filter builder: regex escaping, AND logic
- `cleanPatch`: validation and field whitelist
- Research extractors: same-domain/generic emails only, job-like role links only

Manual/API smoke (run during the build against live Mongo): import + re-import (no duplicates), filters, status PATCH, invalid email rejected, stats, CSV export, research on example.com (honest empty result) and linear.app (careers page, email, roles with sources).

Not covered yet: React component tests, browser E2E, route tests with an in-memory DB.
