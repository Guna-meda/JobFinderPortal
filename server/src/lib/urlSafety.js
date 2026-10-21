import net from 'node:net';

/** Error raised by URL validation and fetching. `code` is stable; `message` is safe to show in the UI. */
export class FetchError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'FetchError';
    this.code = code;
    this.fetchCode = code;
    Object.assign(this, extra);
  }
}

const v4 = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) v4.addSubnet(a, bits, 'ipv4');

const v6 = new net.BlockList();
for (const [a, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['2001::', 32], ['100::', 64],
]) v6.addSubnet(a, bits, 'ipv6');

// Expand an IPv6 literal into eight 16-bit groups (handles "::" and a trailing dotted quad).
function expandV6(ip) {
  let s = ip;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = s.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

const quad = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True for anything that is not a plain public unicast address. Unknown or malformed input is blocked. */
export function isBlockedIp(ip) {
  const a = String(ip).replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(a);
  if (!family) return true;
  if (family === 4) return v4.check(a, 'ipv4');
  const g = expandV6(a);
  if (!g) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  // Addresses that embed an IPv4 address must pass the IPv4 rules too.
  if (zeros(0, 5) && g[5] === 0xffff) return isBlockedIp(quad(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 6)) return isBlockedIp(quad(g[6], g[7])); // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isBlockedIp(quad(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIp(quad(g[1], g[2])); // 6to4
  return v6.check(a, 'ipv6');
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.intranet', '.corp', '.home', '.home.arpa'];
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data']);

export function isBlockedHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return isBlockedIp(h);
  if (!h.includes('.') || BLOCKED_NAMES.has(h)) return true;
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Validate a URL before any network access. Only http(s), no credentials, only allowed ports,
 * no internal-looking hostnames or literal non-public IPs. Returns a URL object (fragment removed).
 */
export function validateFetchUrl(raw, { allowedPorts = [80, 443], hostnameBlocked = isBlockedHostname } = {}) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 2048) throw new FetchError('invalid_url');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u;
  try {
    u = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    throw new FetchError('invalid_url');
  }
  if (!/^https?:$/.test(u.protocol)) throw new FetchError('blocked_scheme');
  if (u.username || u.password) throw new FetchError('invalid_url');
  if (!u.hostname) throw new FetchError('invalid_url');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!allowedPorts.includes(port)) throw new FetchError('blocked_port');
  if (hostnameBlocked(u.hostname)) throw new FetchError('blocked_host');
  u.hash = '';
  return u;
}

// Rough registrable-domain check (no public-suffix list): good enough to keep a crawl on one company's site.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
export function siteKey(hostname) {
  const labels = String(hostname).toLowerCase().replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const take = labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-take).join('.');
}
export const sameSite = (a, b) => siteKey(a) === siteKey(b);
