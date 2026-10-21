import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { researchConfig } from '../config/research.js';
import { FetchError, validateFetchUrl, isBlockedIp, sameSite } from './urlSafety.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeBody(buf, contentType = '') {
  let label = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!label) label = (buf.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try {
    return new TextDecoder(label || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * A fetcher that only ever talks to public HTTP(S) hosts. Properties:
 *  - the URL is validated (scheme, credentials, port, hostname) before any network access;
 *  - DNS is resolved inside the connection's own lookup, every address must be public, and that same
 *    validated answer is what the socket connects to (no second resolution, so no DNS rebinding window);
 *  - redirects are followed manually (max N), each hop is fully re-validated, and off-site hops are refused;
 *  - hard timeout, response size cap, identity encoding only, no cookies, no JavaScript execution;
 *  - minimum interval between requests to the same host (shared by every caller of this fetcher).
 * Options exist so tests can point it at local fixture servers; production code uses the defaults.
 */
export function createSafeFetcher(options = {}) {
  const cfg = { ...researchConfig, ...options };
  const lookupFn = options.lookup || ((host, o) => dns.lookup(host, o));
  const ipAllowed = options.isIpAllowed || ((ip) => !isBlockedIp(ip));
  const validateOpts = { allowedPorts: cfg.allowedPorts, ...(options.hostnameBlocked ? { hostnameBlocked: options.hostnameBlocked } : {}) };
  const tails = new Map();
  const lastAt = new Map();
  const delays = new Map();

  const validate = (raw) => validateFetchUrl(raw, validateOpts);

  async function throttle(host) {
    const prev = tails.get(host) || Promise.resolve();
    const mine = prev.then(async () => {
      const gap = Math.max(cfg.minIntervalMs, delays.get(host) || 0);
      const wait = (lastAt.get(host) || 0) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt.set(host, Date.now());
    });
    tails.set(host, mine.catch(() => {}));
    await mine;
  }

  function requestOnce(url, { maxBytes, headers }) {
    return new Promise((resolve, reject) => {
      const state = { blocked: false, dnsFailed: false };
      // Resolves and validates every address; the socket connects to one of these validated addresses.
      const lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') [cb, opts] = [opts, {}];
        lookupFn(hostname, { all: true, verbatim: true }).then(
          (addrs) => {
            if (!addrs.length || addrs.some((a) => !ipAllowed(a.address, { hostname, port: Number(url.port) }))) {
              state.blocked = true;
              return cb(new Error('blocked'));
            }
            if (opts && opts.all) cb(null, addrs);
            else cb(null, addrs[0].address, addrs[0].family);
          },
          () => {
            state.dnsFailed = true;
            cb(new Error('dns'));
          }
        );
      };
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(v);
      };
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, { method: 'GET', headers, lookup, agent: false }, (res) => {
        const status = res.statusCode;
        const h = res.headers;
        if (status >= 300 && status < 400 && h.location) {
          res.resume();
          res.destroy();
          return finish(resolve, { status, headers: h });
        }
        const enc = String(h['content-encoding'] || 'identity').toLowerCase();
        if (enc !== 'identity') {
          res.destroy();
          return finish(reject, new FetchError('unsupported_encoding'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            const keep = c.length - (size - maxBytes);
            if (keep > 0) chunks.push(c.subarray(0, keep));
            res.destroy();
            finish(resolve, { status, headers: h, body: Buffer.concat(chunks), truncated: true });
          } else chunks.push(c);
        });
        res.on('end', () => finish(resolve, { status, headers: h, body: Buffer.concat(chunks), truncated: false }));
        res.on('error', (e) => finish(reject, e));
      });
      const timer = setTimeout(() => {
        req.destroy();
        finish(reject, new FetchError('timeout', undefined, { retryable: true }));
      }, cfg.timeoutMs);
      req.on('error', (e) => {
        if (state.blocked) return finish(reject, new FetchError('blocked_address'));
        if (state.dnsFailed || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return finish(reject, new FetchError('dns_failed', undefined, { retryable: true }));
        if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(e.code))) return finish(reject, new FetchError('tls_error'));
        finish(reject, e instanceof FetchError ? e : new FetchError('connection_failed', undefined, { retryable: true }));
      });
      req.end();
    });
  }

  /**
   * GET a page. `siteHost` (optional) keeps redirects on one company's site. `budget` ({used,max}) caps requests.
   * Returns { url, status, contentType, text, truncated } for any non-redirect response (callers interpret status).
   * Throws FetchError for validation, network, redirect and content problems.
   */
  async function get(rawUrl, { siteHost, budget, kind = 'html', maxBytes = cfg.maxBytes } = {}) {
    let url = validate(rawUrl);
    for (let hop = 0; ; hop++) {
      if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !ipAllowed(url.hostname.replace(/^\[|\]$/g, ''), { hostname: url.hostname, port: Number(url.port) })) {
        throw new FetchError('blocked_address');
      }
      if (budget) {
        if (budget.used >= budget.max) throw new FetchError('request_limit');
        budget.used++;
      }
      await throttle(url.hostname);
      const res = await requestOnce(url, {
        maxBytes,
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: kind === 'html' ? 'text/html,application/xhtml+xml' : 'text/plain,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= cfg.maxRedirects) throw new FetchError('redirect_limit');
        let next;
        try {
          next = validate(new URL(res.headers.location, url).href);
        } catch (e) {
          throw e instanceof FetchError ? e : new FetchError('invalid_url');
        }
        if (siteHost && !sameSite(next.hostname, siteHost)) {
          throw new FetchError('redirect_offsite', undefined, { location: `${next.protocol}//${next.host}/` });
        }
        url = next;
        continue;
      }
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (res.status >= 200 && res.status < 300 && kind === 'html' && !/html|xhtml/.test(contentType)) {
        throw new FetchError('not_html');
      }
      return {
        url: url.href,
        status: res.status,
        contentType,
        text: res.body ? decodeBody(res.body, contentType) : '',
        truncated: !!res.truncated,
      };
    }
  }

  return {
    get,
    validate,
    allowedPorts: cfg.allowedPorts,
    setHostDelay: (host, ms) => delays.set(host, Math.min(ms, cfg.maxCrawlDelayMs)),
  };
}

// Shared by all research so the per-host rate limit holds across companies and concurrent runs.
export const defaultFetcher = createSafeFetcher();
