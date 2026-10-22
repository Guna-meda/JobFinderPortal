import { createRateLimiter, rateLimitMiddleware } from '../lib/rateLimit.js';

const list = (v, fallback) => {
  const items = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
};

export const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '::1'];
export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** Security settings from the environment. ALLOWED_HOSTS / CORS_ORIGINS are comma separated. */
export function securityFromEnv(env = process.env) {
  return { allowedHosts: list(env.ALLOWED_HOSTS, DEFAULT_HOSTS), allowedOrigins: list(env.CORS_ORIGINS, DEFAULT_ORIGINS) };
}

export const DEFAULT_LIMITS = {
  general: { max: 600, windowMs: 60_000 }, // every API call, per client address
  research: { max: 20, windowMs: 60_000 }, // starting research on one company
  batch: { max: 5, windowMs: 60_000 }, // queueing research for several companies
  import: { max: 20, windowMs: 10 * 60_000 }, // CSV preview / import
  outreach: { max: 60, windowMs: 60_000 }, // drafting (AI drafts also have their own tighter limit)
};

/** API responses are data, never pages: forbid sniffing, framing, scripts and caching. */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const hostnameOf = (hostHeader) => {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')); // [::1]:4000
  return h.split(':')[0];
};

/**
 * Reject requests whose Host header is not one of ours. A page on another site that makes your browser resolve
 * its own domain to 127.0.0.1 ("DNS rebinding") arrives with that site's name in Host, so it is refused here.
 */
export function hostGuard(allowedHosts) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase().replace(/^\[|\]$/g, '')));
  return (req, res, next) => {
    if (allowed.has(hostnameOf(req.headers.host))) return next();
    return res.status(403).json({ error: 'This host name is not allowed.', code: 'host_not_allowed' });
  };
}

/**
 * Reject browser requests that come from a page on another origin. Requests without an Origin header
 * (curl, the Vite proxy, server-to-server) are not browser cross-site requests and pass.
 */
export function originGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin) || origin === `${req.protocol}://${req.headers.host}`) return next();
    return res.status(403).json({ error: 'Cross-site requests are not allowed.', code: 'origin_not_allowed' });
  };
}

export function buildLimiters(overrides = {}) {
  const cfg = { ...DEFAULT_LIMITS, ...overrides };
  return Object.fromEntries(
    Object.entries(cfg).map(([name, c]) => [name, rateLimitMiddleware(createRateLimiter(c), 'Too many requests. Please slow down and try again shortly.')])
  );
}

/**
 * Error responses never carry stack traces, model names, paths, connection strings or parser internals.
 * Details go to the server log only (without request bodies).
 */
export function errorHandler(err, req, res, next) {
  void next;
  if (res.headersSent) return undefined;
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (10 MB max).', code: 'file_too_large' });
  if (err.name === 'MulterError') return res.status(400).json({ error: 'The upload was not accepted. Send one CSV file and no extra form fields.', code: 'bad_upload' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.', code: 'too_large' });
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'bad_json' });
  }
  if (err.name === 'ValidationError' && err.errors) {
    const fields = Object.keys(err.errors).slice(0, 5).join(', ');
    return res.status(400).json({ error: `Invalid value for: ${fields}.`, code: 'invalid_input' });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid value for ${String(err.path || 'a field').slice(0, 40)}.`, code: 'invalid_input' });

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    console.error(`${req.method} ${req.path} failed:`, err); // server log only
    // A few failures (e.g. a partial import) carry a message written to be shown; everything else is generic.
    if (err.expose === true) return res.status(500).json({ error: String(err.message).slice(0, 400), ...(typeof err.code === 'string' ? { code: err.code } : {}) });
    return res.status(500).json({ error: 'Internal server error' });
  }
  return res.status(status).json({
    error: String(err.message || 'Request failed').slice(0, 300),
    ...(typeof err.code === 'string' ? { code: err.code } : {}),
  });
}
