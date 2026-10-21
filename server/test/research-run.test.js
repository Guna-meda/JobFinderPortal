import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../src/lib/researchRun.js';
import { createSafeFetcher } from '../src/lib/safeFetch.js';
import { researchConfig } from '../src/config/research.js';
import { startFixture, testFetcher, site, send, page } from './helpers/fixture.js';

const NAV = `<nav><a href="/careers">Careers</a><a href="/contact">Contact</a><a href="/about">About</a>
  <a href="/team">Team</a><a href="/press">Press</a><a href="https://jobs.lever.co/fixture">We're hiring</a></nav>`;

const ROUTES = {
  '/': page(`${NAV}<h1>Fixture Robotics</h1><p>We build robots.</p>`),
  '/careers': page(`<h1>Careers</h1>
    <a href="/careers/backend"><span>Backend Engineer</span><span>Remote</span></a>
    <a href="/careers/ml">Machine Learning Intern</a>
    <a href="/careers/sales">Account Executive</a>
    <a href="https://jobs.lever.co/fixture/1">Software Engineer</a>`),
  '/contact': page('<a href="mailto:careers@fixture.test">Jobs</a><p>hello@fixture.test, jane.doe@fixture.test</p>'),
  '/about': page('<p>Founded in 2020.</p>'),
  '/team': page('<p>Our people.</p>'),
  '/press': page('<p>Fixture Robotics raised a $3M seed round in May 2024.</p>'),
};

async function withSite(routes, fn, { cfg = {}, fetcherExtra = {}, website } = {}) {
  const fx = await startFixture(site({ ...ROUTES, ...routes }));
  const base = `http://fixture.test:${fx.port}`;
  const config = { ...researchConfig, maxRedirects: 3, timeoutMs: 2000, ...cfg };
  const fetcher = testFetcher([fx.port], fetcherExtra);
  try {
    const run = (company = {}) => runResearch({ company: { name: 'Fixture Robotics', website: website ?? base, ...company }, fetcher, config });
    return await fn({ run, hits: fx.hits, base, fx });
  } finally {
    await fx.close();
  }
}
const pagesHit = (hits) => hits.filter((h) => h.path !== '/robots.txt').map((h) => h.path.split('?')[0]);

test('a full run records findings, each with its own source URL and observation time', async () => {
  await withSite({}, async ({ run, hits, base }) => {
    const res = await run();
    assert.equal(res.status, 'researched');
    assert.equal(res.error, null);
    const by = (k) => res.findings.filter((f) => f.kind === k);

    const [careers] = by('careers');
    assert.equal(careers.value, `${base}/careers`);
    assert.equal(careers.sourceUrl, `${base}/`); // found as a link on the homepage
    assert.equal(careers.confidence, 'verified');
    assert.equal(careers.basis, 'official-link');

    const roles = by('role');
    assert.deepEqual(roles.map((r) => r.title).sort(), ['Backend Engineer Remote', 'Machine Learning Intern', 'Software Engineer']);
    assert.ok(roles.every((r) => r.sourceUrl === `${base}/careers` && r.confidence === 'inferred' && r.basis === 'keyword-match'));
    assert.ok(!roles.some((r) => /Account Executive/.test(r.title)));

    const emails = by('email');
    assert.deepEqual(emails.map((e) => e.value).sort(), ['careers@fixture.test', 'hello@fixture.test']);
    assert.ok(emails.every((e) => e.sourceUrl === `${base}/contact` && e.confidence === 'verified'));
    assert.ok(!emails.some((e) => /jane/.test(e.value)), 'personal-looking addresses are not stored');

    const [funding] = by('funding');
    assert.equal(funding.sourceUrl, `${base}/press`);
    assert.equal(funding.confidence, 'unverified');
    assert.equal(funding.basis, 'company-statement');
    assert.deepEqual([funding.meta.stage, funding.meta.amount, funding.meta.date], ['seed', '$3M', 'May 2024']);

    assert.ok(res.findings.every((f) => f.observedAt instanceof Date && f.sourceUrl.startsWith(base)));
    assert.deepEqual(res.notFound, []);
    assert.equal(res.pages, 6);
    // The hiring-platform link was recorded as a role but never fetched, and nothing off-site was requested.
    assert.ok(pagesHit(hits).every((p) => ['/', '/careers', '/contact', '/about', '/team', '/press'].includes(p)));
  });
});

test('the per-company page limit and request budget are enforced', async () => {
  await withSite({}, async ({ run, hits }) => {
    const res = await run();
    assert.equal(res.status, 'partial');
    assert.equal(pagesHit(hits).length, 3);
    assert.ok(res.log.some((l) => /Page limit reached/.test(l)));
  }, { cfg: { maxPages: 3 } });

  await withSite({}, async ({ run, hits }) => {
    const res = await run();
    assert.ok(hits.length <= 3, `made ${hits.length} requests with a budget of 3`);
    assert.equal(res.status, 'partial');
    assert.ok(res.log.some((l) => /request limit/i.test(l)));
  }, { cfg: { maxRequests: 3 } });
});

// ---------- robots.txt ----------

const robots = (text) => ({ '/robots.txt': { body: text, type: 'text/plain' } });

test('robots.txt Disallow is respected for individual pages', async () => {
  await withSite(robots('User-agent: *\nDisallow: /careers\n'), async ({ run, hits, base }) => {
    const res = await run();
    assert.ok(!pagesHit(hits).includes('/careers'), 'a disallowed page must not be requested');
    assert.equal(res.status, 'partial');
    assert.ok(res.log.some((l) => /robots\.txt disallows|robots\.txt disallow/i.test(l) || /robots/.test(l)));
    const careers = res.findings.find((f) => f.kind === 'careers');
    assert.equal(careers.confidence, 'unverified'); // the link exists, the page was not read
    assert.match(careers.evidence, /robots/);
    assert.equal(careers.value, `${base}/careers`);
    assert.ok(res.findings.some((f) => f.kind === 'email'), 'other allowed pages are still read');
  });
});

test('robots.txt: Disallow all stops the run before the homepage is requested', async () => {
  await withSite(robots('User-agent: *\nDisallow: /\n'), async ({ run, hits }) => {
    const res = await run();
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'robots_disallowed');
    assert.deepEqual(hits.map((h) => h.path), ['/robots.txt']);
  });
});

test('robots.txt: our own user-agent group and Allow precedence are honoured', async () => {
  await withSite(robots('User-agent: StartupFinderBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'), async ({ run }) => {
    assert.equal((await run()).error.code, 'robots_disallowed');
  });
  await withSite(robots('User-agent: *\nDisallow: /c\nAllow: /careers\n'), async ({ run, hits }) => {
    await run();
    const p = pagesHit(hits);
    assert.ok(p.includes('/careers'), 'longest-match Allow wins');
    assert.ok(!p.includes('/contact'), '/contact is covered by Disallow: /c');
  });
});

test('robots.txt missing (404) means no restriction; unreadable (500) stops the run as retryable', async () => {
  await withSite({ '/robots.txt': { status: 404, body: 'nope' } }, async ({ run }) => {
    assert.equal((await run()).status, 'researched');
  });
  await withSite({ '/robots.txt': { status: 500, body: 'oops' } }, async ({ run, hits }) => {
    const res = await run();
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'robots_unavailable');
    assert.equal(res.error.retryable, true);
    assert.deepEqual(hits.map((h) => h.path), ['/robots.txt']);
  });
});

// ---------- failures ----------

test('homepage failures are stored with a useful, safe error and a retry hint', async () => {
  const cases = [
    [{ '/': { status: 404, body: page('gone') } }, 'not_found_page', false],
    [{ '/': { status: 403, body: 'blocked' } }, 'access_denied', false],
    [{ '/': { status: 429, body: 'slow down' } }, 'rate_limited', true],
    [{ '/': { status: 503, body: 'down' } }, 'server_error', true],
    [{ '/': { body: '{"x":1}', type: 'application/json' } }, 'not_html', false],
  ];
  for (const [routes, code, retryable] of cases) {
    await withSite(routes, async ({ run }) => {
      const res = await run();
      assert.equal(res.status, 'failed', code);
      assert.equal(res.error.code, code);
      assert.equal(res.error.retryable, retryable, code);
      assert.equal(res.findings.length, 0);
    });
  }
});

test('a hanging website times out as a retryable failure', async () => {
  await withSite({ '/': { raw: () => {} } }, async ({ run }) => {
    const started = Date.now();
    const res = await run();
    assert.equal(res.error.code, 'timeout');
    assert.equal(res.error.retryable, true);
    assert.ok(Date.now() - started < 3000);
  }, { fetcherExtra: { timeoutMs: 300 } });
});

test('connection failure and unknown hosts are retryable failures', async () => {
  const dead = await startFixture(() => {});
  const port = dead.port;
  await dead.close();
  const f = testFetcher([port]);
  const config = { ...researchConfig, timeoutMs: 1000 };
  const a = await runResearch({ company: { name: 'X', website: `http://gone.test:${port}` }, fetcher: f, config });
  assert.deepEqual([a.status, a.error.code, a.error.retryable], ['failed', 'connection_failed', true]);
  const b = await runResearch({ company: { name: 'X', website: 'http://nowhere.example:80' }, fetcher: testFetcher([80]), config });
  assert.deepEqual([b.status, b.error.code, b.error.retryable], ['failed', 'dns_failed', true]);
});

test('a redirect to another site is not followed; the target is offered as a website finding', async () => {
  const routes = { '/': { raw: (req, res) => { res.writeHead(302, { Location: `http://other.example.test:${req.socket.localPort}/` }); res.end(); } } };
  await withSite(routes, async ({ run, hits }) => {
    const res = await run();
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'redirect_offsite');
    const [w] = res.findings;
    assert.equal(w.kind, 'website');
    assert.equal(w.confidence, 'unverified');
    assert.equal(w.basis, 'redirect');
    assert.match(w.value, /other\.example\.test/);
    assert.ok(!hits.some((h) => h.headers.host?.startsWith('other.example.test')), 'the other site is never requested');
  });
});

test('invalid, internal and private targets fail without any network traffic', async () => {
  const strict = createSafeFetcher({ minIntervalMs: 0, timeoutMs: 500 });
  const config = { ...researchConfig };
  const cases = {
    'not a url at all': 'invalid_url',
    'ftp://example.com': 'blocked_scheme',
    'http://127.0.0.1/': 'blocked_host',
    'http://localhost/admin': 'blocked_host',
    'http://169.254.169.254/latest/meta-data/': 'blocked_host',
    'http://10.0.0.5:80/': 'blocked_host',
    'http://example.com:8080/': 'blocked_port',
    '': 'invalid_url',
  };
  for (const [website, code] of Object.entries(cases)) {
    const res = await runResearch({ company: { name: 'X', website }, fetcher: strict, config });
    assert.equal(res.status, 'failed', website);
    assert.equal(res.error.code, code, website);
    assert.deepEqual(Object.keys(res.error).sort(), ['code', 'message', 'retryable']);
    assert.ok(!/127\.0\.0\.1|169\.254|10\.0\.0\.5|stack|\bat \w+ \(|node_modules|\\Users\\/i.test(res.error.message), res.error.message);
  }
  const privateName = createSafeFetcher({ lookup: async () => [{ address: '10.9.9.9', family: 4 }], minIntervalMs: 0 });
  const res = await runResearch({ company: { name: 'X', website: 'https://looks-public.example.com' }, fetcher: privateName, config });
  assert.equal(res.error.code, 'blocked_address');
  assert.ok(!res.error.message.includes('10.9.9.9'));
  assert.ok(!res.log.join('\n').includes('10.9.9.9'));
});

// ---------- evidence semantics ----------

test('malformed homepage HTML yields "not found", never a crash or an invented finding', async () => {
  await withSite({ '/': { body: '<<<>>><a href="/careers>Careers <div><b>' } }, async ({ run }) => {
    const res = await run();
    assert.ok(['not_found', 'researched', 'partial'].includes(res.status));
    assert.ok(!res.findings.some((f) => f.kind === 'email' || f.kind === 'role' || f.kind === 'funding'));
  });
  await withSite({ '/': { body: '' } }, async ({ run }) => {
    const res = await run();
    assert.equal(res.status, 'not_found');
    assert.deepEqual(res.findings, []);
    assert.deepEqual(res.notFound.sort(), ['careers', 'email']);
  });
});

test('missing items are reported as not detected; a dead careers link is kept as unverified', async () => {
  await withSite({ '/': page('<a href="/about">About</a>'), '/about': page('<p>Hi</p>') }, async ({ run }) => {
    const res = await run();
    assert.equal(res.status, 'not_found');
    assert.deepEqual(res.notFound.sort(), ['careers', 'email']);
  });
  await withSite({ '/careers': { status: 404, body: page('gone') } }, async ({ run }) => {
    const res = await run();
    assert.equal(res.status, 'partial');
    const c = res.findings.find((f) => f.kind === 'careers');
    assert.equal(c.confidence, 'unverified');
    assert.match(c.evidence, /could not be loaded/);
    assert.ok(!res.findings.some((f) => f.kind === 'role'));
  });
  await withSite({ '/careers': page('<h1>Careers</h1><p>Nothing open.</p>') }, async ({ run }) => {
    const res = await run();
    assert.ok(res.notFound.includes('roles'));
  });
});

test('a hiring-platform link alone is recorded as inferred and never fetched', async () => {
  const home = page('<a href="https://jobs.lever.co/fixture">Careers</a>');
  await withSite({ '/': home }, async ({ run, hits }) => {
    const res = await run();
    const c = res.findings.find((f) => f.kind === 'careers');
    assert.equal(c.confidence, 'inferred');
    assert.equal(c.value, 'https://jobs.lever.co/fixture');
    assert.match(c.evidence, /Not fetched/);
    assert.deepEqual(pagesHit(hits), ['/']);
  });
});

test('every finding points at a page that was actually read', async () => {
  await withSite({}, async ({ run, hits, base }) => {
    const res = await run();
    const read = new Set(pagesHit(hits).map((p) => `${base}${p}`));
    for (const f of res.findings) assert.ok(read.has(f.sourceUrl), `${f.kind} source ${f.sourceUrl} was not fetched`);
  });
});

test('configurable role keywords change what is detected', async () => {
  await withSite({}, async ({ run }) => {
    const res = await run();
    assert.deepEqual(res.findings.filter((f) => f.kind === 'role').map((r) => r.title), ['Account Executive']);
  }, { cfg: { roleKeywords: ['executive'] } });
});

void send;
