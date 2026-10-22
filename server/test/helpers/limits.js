// Rate limits effectively off, for tests that hammer endpoints. The limiters themselves are tested in security.test.js.
const off = { max: 1_000_000, windowMs: 1000 };
export const NO_LIMITS = { general: off, research: off, batch: off, import: off, outreach: off };
