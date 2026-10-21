import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { validateFetchUrl, isBlockedIp, FetchError, siteKey, sameSite } from '../src/lib/urlSafety.js';
import { createSafeFetcher } from '../src/lib/safeFetch.js';
import { startFixture, testFetcher, send, page } from './helpers/fixture.js';

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FetchError ? e.code : `other:${e.message}`;
  }
  return 'none';
};
const rejects = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e instanceof FetchError ? e.code : `other:${e.message}`;
  }
  return 'none';
};

// ---------- URL validation ----------

test('invalid and unsupported URLs are rejected before any network access', () => {
  const cases = {
    '': 'invalid_url',
    '   ': 'invalid_url',
    'http://': 'invalid_url',
    'not a url': 'invalid_url',
    'javascript:alert(1)': 'invalid_url',
    'ftp://example.com/file': 'blocked_scheme',
    'file:///etc/passwd': 'blocked_scheme',
    'gopher://example.com': 'blocked_scheme',
    'http://user:secret@example.com/': 'invalid_url',
    'http://example.com:8080/': 'blocked_port',
    'https://example.com:22/': 'blocked_port',
    'localhost:3000/admin': 'blocked_port',
    'http://localhost/': 'blocked_host',
    'http://intranet/': 'blocked_host',
    'http://printer.local/': 'blocked_host',
    'http://service.internal/': 'blocked_host',
    'http://metadata.google.internal/computeMetadata/v1/': 'blocked_host',
    'http://127.0.0.1/': 'blocked_host',
    'http://127.1/': 'blocked_host',
    'http://2130706433/': 'blocked_host', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/': 'blocked_host',
    'http://[::1]/': 'blocked_host',
    'http://[::ffff:127.0.0.1]/': 'blocked_host',
    'http://10.1.2.3/': 'blocked_host',
    'http://192.168.0.1/': 'blocked_host',
    'http://172.16.5.5/': 'blocked_host',
    'http://169.254.169.254/latest/meta-data/': 'blocked_host',
    'http://0.0.0.0/': 'blocked_host',
  };
  for (const [input, code] of Object.entries(cases)) assert.equal(codeOf(() => validateFetchUrl(input)), code, input);
  assert.equal(codeOf(() => validateFetchUrl('x'.repeat(3000))), 'invalid_url');
});

test('valid public URLs are accepted and normalised', () => {
  assert.equal(validateFetchUrl('example.com').href, 'https://example.com/');
  assert.equal(validateFetchUrl('http://www.example.com/a?b=1#frag').href, 'http://www.example.com/a?b=1');
  assert.equal(validateFetchUrl('https://example.co.uk:443/x').hostname, 'example.co.uk');
});

test('blocked IP ranges: private, loopback, link-local, metadata, mapped and embedded IPv6', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1',
    '::127.0.0.1', 'not-an-ip', '', '999.1.1.1',
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('site matching keeps a crawl on one company site', () => {
  assert.equal(siteKey('www.acme.io'), 'acme.io');
  assert.equal(siteKey('careers.acme.io'), 'acme.io');
  assert.equal(siteKey('acme.co.uk'), 'acme.co.uk');
  assert.ok(sameSite('jobs.acme.io', 'www.acme.io'));
  assert.ok(!sameSite('acme.io', 'evil-acme.io'));
  assert.ok(!sameSite('acme.io', 'acme.io.evil.com'));
});

// ---------- DNS-level protection (no network needed) ----------

const dnsFetcher = (answers) => createSafeFetcher({ lookup: async () => answers, minIntervalMs: 0, timeoutMs: 1000 });

test('a public-looking name that resolves to a private or metadata address is blocked', async () => {
  for (const address of ['10.0.0.8', '127.0.0.1', '169.254.169.254', '192.168.1.5', '::1', '::ffff:10.0.0.1']) {
    const f = dnsFetcher([{ address, family: address.includes(':') ? 6 : 4 }]);
    assert.equal(await rejects(f.get('https://totally-public.example.com/')), 'blocked_address', address);
  }
});

test('every address in a DNS answer must be public (mixed answers are blocked)', async () => {
  const f = dnsFetcher([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  assert.equal(await rejects(f.get('https://mixed.example.com/')), 'blocked_address');
});

test('DNS failure and empty answers are reported, not thrown raw', async () => {
  const failing = createSafeFetcher({ lookup: async () => { throw new Error('ENOTFOUND'); }, minIntervalMs: 0, timeoutMs: 1000 });
  assert.equal(await rejects(failing.get('https://nope.example.com/')), 'dns_failed');
  assert.equal(await rejects(dnsFetcher([]).get('https://empty.example.com/')), 'blocked_address');
});

test('literal private IPs are refused without resolving or connecting', async () => {
  let looked = 0;
  const f = createSafeFetcher({ lookup: async () => { looked++; return [{ address: '8.8.8.8', family: 4 }]; }, minIntervalMs: 0 });
  assert.equal(await rejects(f.get('http://127.0.0.1/')), 'blocked_host');
  assert.equal(await rejects(f.get('http://[::1]/')), 'blocked_host');
  assert.equal(looked, 0);
});

// ---------- behaviour against local fixture servers ----------

let a, b, ports, hang;
before(async () => {
  b = await startFixture((req, res) => send(res, page('internal secret')));
  a = await startFixture((req, res) => {
    const path = req.url.split('?')[0];
    const to = (loc, status = 302) => { res.writeHead(status, { Location: loc }); res.end(); };
    switch (path) {
      case '/ok': return send(res, page('hello'));
      case '/missing': return send(res, page('gone'), { status: 404 });
      case '/redirect-ok': return to('/final');
      case '/final': return send(res, page('final page'));
      case '/to-internal-port': return to(`http://127.0.0.1:${b.port}/secret`);
      case '/to-internal-name': return to(`http://internal.test:${b.port}/secret`);
      case '/to-metadata': return to('http://169.254.169.254/latest/meta-data/');
      case '/to-private-name': return to(`http://evil.test:${a.port}/ok`);
      case '/to-ftp': return to('ftp://example.com/x');
      case '/to-file': return to('file:///etc/passwd');
      case '/to-offsite': return to(`http://other.example.test:${a.port}/ok`);
      case '/loop': return to('/loop');
      case '/hang': return undefined; // never answers
      case '/slow-body':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return void (() => {
          const t = setInterval(() => res.write('<p>drip</p>'), 50);
          res.on('close', () => clearInterval(t));
        })();
      case '/big':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return void (function pump() {
          if (res.destroyed || res.writableEnded) return;
          if (!res.write('<p>' + 'x'.repeat(60_000) + '</p>')) res.once('drain', pump);
          else setImmediate(pump);
        })();
      case '/json': return send(res, '{"a":1}', { type: 'application/json' });
      case '/gzip': return send(res, 'zzz', { headers: { 'Content-Encoding': 'gzip' } });
      case '/echo': return send(res, page(JSON.stringify(req.headers)));
      case '/latin1': return send(res, Buffer.from(page('caf\xe9'), 'latin1'), { type: 'text/html; charset=iso-8859-1' });
      default: return send(res, page('default'));
    }
  });
  ports = [a.port, b.port];
  hang = true;
});
after(async () => {
  await Promise.all([a.close(), b.close()]);
});

const base = () => `http://fixture.test:${a.port}`;
const fetcher = (extra) => testFetcher(ports, extra);

test('fetches a normal page and returns status without throwing on HTTP errors', async () => {
  const f = fetcher();
  const ok = await f.get(`${base()}/ok`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /hello/);
  const missing = await f.get(`${base()}/missing`);
  assert.equal(missing.status, 404);
});

test('connects to the validated address and resolves DNS exactly once per request (no rebinding window)', async () => {
  let calls = 0;
  const f = fetcher({
    lookup: async () => (++calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.9', family: 4 }]),
  });
  const before = a.hits.length;
  const r = await f.get(`${base()}/ok`);
  assert.equal(r.status, 200);
  assert.equal(calls, 1);
  assert.equal(a.hits.length, before + 1);
  assert.equal(a.hits.at(-1).headers.host, `fixture.test:${a.port}`); // original hostname preserved for the Host header
  // The next request resolves again, now sees a private address, and is blocked.
  assert.equal(await rejects(f.get(`${base()}/ok`)), 'blocked_address');
});

test('redirects to internal destinations are blocked on every hop', async () => {
  const secretHits = b.hits.length;
  // Port B passes the port rule here, so only the address check stands between the redirect and the internal server.
  const guarded = () => testFetcher([a.port], { allowedPorts: [a.port, b.port] });
  assert.equal(await rejects(guarded().get(`${base()}/to-internal-port`)), 'blocked_address');
  assert.equal(await rejects(guarded().get(`${base()}/to-internal-name`)), 'blocked_address');
  // With only A's port allowed, the port rule refuses the redirect first.
  const portOnly = () => testFetcher([a.port]);
  assert.equal(await rejects(portOnly().get(`${base()}/to-internal-port`)), 'blocked_port');
  assert.equal(b.hits.length, secretHits, 'the internal server must never be contacted');
  // Production hostname policy and standard ports: the cloud metadata address is refused as a host.
  const prodRules = testFetcher([a.port], { allowedPorts: [a.port, 80, 443], hostnameBlocked: undefined });
  assert.equal(await rejects(prodRules.get(`${base()}/to-metadata`)), 'blocked_host');
  assert.equal(await rejects(fetcher().get(`${base()}/to-ftp`)), 'blocked_scheme');
  assert.equal(await rejects(fetcher().get(`${base()}/to-file`)), 'blocked_scheme');
});

test('a redirect to a name that resolves privately is blocked at DNS time', async () => {
  const f = fetcher({
    lookup: async (host) => (host === 'evil.test' ? [{ address: '10.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
  });
  assert.equal(await rejects(f.get(`${base()}/to-private-name`)), 'blocked_address');
});

test('same-site redirects are followed; off-site redirects are refused with the target reported', async () => {
  const f = fetcher();
  const r = await f.get(`${base()}/redirect-ok`, { siteHost: 'fixture.test' });
  assert.equal(r.url, `${base()}/final`);
  try {
    await f.get(`${base()}/to-offsite`, { siteHost: 'fixture.test' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'redirect_offsite');
    assert.match(e.location, /other\.example\.test/);
  }
});

test('redirect loops stop at the redirect limit', async () => {
  assert.equal(await rejects(fetcher({ maxRedirects: 3 }).get(`${base()}/loop`)), 'redirect_limit');
});

test('requests time out instead of hanging', async () => {
  const started = Date.now();
  assert.equal(await rejects(fetcher({ timeoutMs: 300 }).get(`${base()}/hang`)), 'timeout');
  assert.ok(Date.now() - started < 2000);
  const slow = Date.now();
  assert.equal(await rejects(fetcher({ timeoutMs: 400 }).get(`${base()}/slow-body`)), 'timeout');
  assert.ok(Date.now() - slow < 2000, 'a slow-drip response is cut off by the overall timeout');
});

test('response size is capped', async () => {
  const r = await fetcher({ maxBytes: 100_000 }).get(`${base()}/big`);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 100_000);
  assert.ok(r.text.length > 50_000);
});

test('non-HTML and compressed responses are rejected', async () => {
  assert.equal(await rejects(fetcher().get(`${base()}/json`)), 'not_html');
  assert.equal(await rejects(fetcher().get(`${base()}/gzip`)), 'unsupported_encoding');
});

test('sends no cookies or credentials, identifies itself, and decodes legacy charsets', async () => {
  const f = fetcher({ userAgent: 'StartupFinderBot/test' });
  const body = (await f.get(`${base()}/echo`)).text;
  const echo = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
  assert.equal(echo['user-agent'], 'StartupFinderBot/test');
  assert.equal(echo['accept-encoding'], 'identity');
  assert.ok(!('cookie' in echo) && !('authorization' in echo));
  assert.match((await f.get(`${base()}/latin1`)).text, /café/);
});

test('request budget caps total requests, including redirect hops', async () => {
  const f = fetcher();
  const budget = { used: 0, max: 2 };
  await f.get(`${base()}/redirect-ok`, { budget }); // 2 requests: redirect + final
  assert.equal(budget.used, 2);
  assert.equal(await rejects(f.get(`${base()}/ok`, { budget })), 'request_limit');
});

test('per-host rate limit spaces requests to one host but not across hosts', async () => {
  const f = fetcher({ minIntervalMs: 200 });
  const t0 = Date.now();
  await Promise.all([f.get(`${base()}/ok`), f.get(`${base()}/ok`), f.get(`${base()}/ok`)]);
  assert.ok(Date.now() - t0 >= 380, `same host should take >= 2 intervals, took ${Date.now() - t0}`);
  const t1 = Date.now();
  await Promise.all([
    f.get(`http://one.test:${a.port}/ok`),
    f.get(`http://two.test:${a.port}/ok`),
    f.get(`http://three.test:${a.port}/ok`),
  ]);
  assert.ok(Date.now() - t1 < 190, `different hosts should not wait, took ${Date.now() - t1}`);
});

test('crawl-delay from robots.txt raises the spacing for that host', async () => {
  const f = fetcher({ minIntervalMs: 0 });
  f.setHostDelay('delay.test', 250);
  const t0 = Date.now();
  await f.get(`http://delay.test:${a.port}/ok`);
  await f.get(`http://delay.test:${a.port}/ok`);
  assert.ok(Date.now() - t0 >= 230);
});

test('connection refused is reported as a retryable connection failure', async () => {
  const dead = await startFixture(() => {});
  const port = dead.port;
  await dead.close();
  try {
    await testFetcher([port]).get(`http://gone.test:${port}/`);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'connection_failed');
    assert.equal(e.retryable, true);
  }
});

void hang;
