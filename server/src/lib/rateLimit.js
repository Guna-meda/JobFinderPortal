/**
 * Small in-memory sliding-window limiter. Good enough for a single-process personal tool; it does not
 * share state across processes or restarts. `take(key)` returns true if the call may proceed.
 */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    take(key = 'global') {
      const t = now();
      const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return true;
    },
    retryAfterSeconds(key = 'global') {
      const t = now();
      const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
      return recent.length ? Math.max(1, Math.ceil((windowMs - (t - Math.min(...recent))) / 1000)) : 0;
    },
  };
}

/** Express middleware: 429 with Retry-After when the caller (by IP) exceeds the limit. */
export function rateLimitMiddleware(limiter, message = 'Too many requests. Please slow down.') {
  return (req, res, next) => {
    const key = req.ip || 'local';
    if (limiter.take(key)) return next();
    res.setHeader('Retry-After', String(limiter.retryAfterSeconds(key)));
    return res.status(429).json({ error: message, code: 'rate_limited' });
  };
}
