// Research limits and keywords. Roles keywords can be overridden with RESEARCH_ROLE_KEYWORDS (comma separated).
const list = (v, fallback) => {
  const items = (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
};

export const DEFAULT_ROLE_KEYWORDS = [
  'engineer', 'engineering', 'developer', 'software', 'backend', 'back-end', 'frontend', 'front-end', 'full stack',
  'fullstack', 'sde', 'swe', 'ai', 'ml', 'machine learning', 'data scientist', 'devops', 'sre', 'site reliability',
  'infrastructure', 'platform', 'security engineer', 'founding engineer', 'forward deployed', 'intern',
];

export const researchConfig = {
  userAgent: 'StartupFinderBot/1.0 (personal job-search tool; low volume, honours robots.txt)',
  robotsToken: 'StartupFinderBot',
  timeoutMs: 8000, // per request, including the whole response
  maxBytes: 1_000_000, // per response
  maxRedirects: 3,
  maxPages: 6, // HTML pages per company, homepage included
  maxRequests: 10, // all requests per company: pages, robots.txt, every redirect hop
  deadlineMs: 45_000, // wall-clock cap per company
  minIntervalMs: 1000, // minimum gap between requests to the same host
  maxCrawlDelayMs: 10_000,
  allowedPorts: [80, 443],
  staleDays: 90,
  maxFindings: 100,
  maxRoles: 25,
  lockMs: 5 * 60 * 1000, // a 'running' marker older than this is treated as a crashed run
  concurrency: 2, // companies researched at once (each host is still rate limited)
  batchLimit: 25,
  roleKeywords: list(process.env.RESEARCH_ROLE_KEYWORDS, DEFAULT_ROLE_KEYWORDS),
};
