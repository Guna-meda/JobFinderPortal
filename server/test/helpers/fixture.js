import http from 'node:http';
import { createSafeFetcher } from '../../src/lib/safeFetch.js';

/** A throwaway local HTTP server that records every request it receives. */
export async function startFixture(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url, headers: req.headers });
    handler(req, res, hits);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    hits,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/**
 * A fetcher for tests: names ending in .test resolve to 127.0.0.1 and only the given fixture ports are
 * reachable. Everything else (other ports, other IPs, real hosts) stays blocked or unresolvable.
 */
export function testFetcher(ports, extra = {}) {
  return createSafeFetcher({
    lookup: async (host) => {
      if (host.endsWith('.test')) return [{ address: '127.0.0.1', family: 4 }];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    isIpAllowed: (ip, { port }) => ip === '127.0.0.1' && ports.includes(port),
    hostnameBlocked: () => false,
    allowedPorts: ports,
    minIntervalMs: 0,
    timeoutMs: 2000,
    ...extra,
  });
}

export const send = (res, body, { status = 200, type = 'text/html; charset=utf-8', headers = {} } = {}) => {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
};

export const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

/** Route table -> request handler. Each route: string body, or { body, status, type, headers, delay, raw }. */
export function site(routes) {
  return (req, res) => {
    const path = req.url.split('?')[0];
    const r = routes[path];
    if (!r) return send(res, page('not found'), { status: 404 });
    const spec = typeof r === 'string' ? { body: r } : r;
    const go = () => (spec.raw ? spec.raw(req, res) : send(res, spec.body ?? '', spec));
    if (spec.delay) setTimeout(go, spec.delay);
    else go();
  };
}
