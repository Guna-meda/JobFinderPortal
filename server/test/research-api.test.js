// Research service + routes against a real MongoDB (test DB only). Skipped, loudly, if MongoDB is unreachable.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import Company from '../src/models/Company.js';
import { createResearchService } from '../src/lib/researchService.js';
import { researchConfig } from '../src/config/research.js';
import { startFixture, testFetcher, site, page } from './helpers/fixture.js';

const URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/startup-finder-test-research';
if (!/test/i.test(new URL(URI).pathname)) throw new Error('Refusing to run API tests against a non-test database');

const NAV = '<a href="/careers">Careers</a><a href="/contact">Contact</a><a href="/press">Press</a>';
const baseRoutes = () => ({
  '/': page(`${NAV}<p>Fixture Robotics</p>`),
  '/careers': page('<a href="/careers/be">Backend Engineer</a><a href="/careers/ml">Machine Learning Engineer</a>'),
  '/contact': page('<a href="mailto:careers@fixture.test">Jobs</a>'),
  '/press': page('<p>Fixture Robotics raised a $3M seed round in May 2024.</p>'),
});

let up = false, app, service, fx, routes, base;

before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000 });
    up = true;
  } catch {
    console.warn(`SKIPPING research API tests: cannot reach MongoDB at ${URI}`);
    return;
  }
  routes = baseRoutes();
  fx = await startFixture((req, res) => site(routes)(req, res));
  base = `http://fixture.test:${fx.port}`;
  const config = { ...researchConfig, timeoutMs: 2000, minIntervalMs: 0 };
  service = createResearchService({ fetcher: testFetcher([fx.port]), config });
  app = createApp({ research: service });
});
after(async () => {
  if (fx) await fx.close();
  if (up) await mongoose.disconnect();
});
beforeEach(async () => {
  if (!up) return;
  await Company.deleteMany({});
  routes = Object.assign(Object.fromEntries(Object.keys(routes).map((k) => [k, undefined])), baseRoutes());
  for (const k of Object.keys(routes)) if (routes[k] === undefined) delete routes[k];
  fx.hits.length = 0;
});

const t = (name, fn) => test(name, async (ctx) => (up ? fn(ctx) : ctx.skip('MongoDB not available')));
const make = async (extra = {}) => (await request(app).post('/api/companies').send({ name: 'Fixture Robotics', website: base, ...extra })).body;
const get = async (id) => (await request(app).get(`/api/companies/${id}`)).body;
const research = async (id) => {
  const r = await request(app).post(`/api/companies/${id}/research`);
  await service.onIdle();
  return r;
};
const decide = (id, fid, body) => request(app).post(`/api/companies/${id}/findings/${fid}`).send(body);
const find = (c, kind, pred = () => true) => c.findings.find((f) => f.kind === kind && pred(f));

t('research starts asynchronously, stores findings with sources, and applies nothing to the company', async () => {
  const c = await make();
  const r = await request(app).post(`/api/companies/${c._id}/research`);
  assert.equal(r.status, 202);
  assert.equal(r.body.researchStatus, 'running');
  await service.onIdle();
  const done = await get(c._id);
  assert.equal(done.researchStatus, 'researched');
  assert.ok(done.researchedAt);
  assert.equal(done.researchProgress, '');
  assert.equal(done.researchStartedAt, undefined);
  assert.ok(done.findings.length >= 4);
  assert.ok(done.findings.every((f) => f.status === 'pending' && f.sourceUrl && f.observedAt && f.confidence));
  // Nothing is applied until the user accepts.
  assert.deepEqual([done.careersUrl, done.contactEmail, done.fundingStatus, done.hasRelevantRoles, done.openRoles.length], ['', '', 'unknown', 'unknown', 0]);
});

t('a second research request while one is running is rejected (no duplicate runs)', async () => {
  routes['/'] = { body: page(NAV), delay: 400 };
  const c = await make();
  const [a, b] = await Promise.all([
    request(app).post(`/api/companies/${c._id}/research`),
    request(app).post(`/api/companies/${c._id}/research`),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal([a, b].find((x) => x.status === 409).body.code, 'already_running');
  await service.onIdle();
  assert.equal(fx.hits.filter((h) => h.path === '/').length, 1, 'the site was only fetched once');
  assert.equal((await request(app).post(`/api/companies/${c._id}/research`)).status, 202); // fine again after completion
  await service.onIdle();
});

t('a crashed run (old running marker) can be retried; a fresh one cannot; restart recovery marks failed', async () => {
  const c = await make();
  await Company.updateOne({ _id: c._id }, { researchStatus: 'running', researchStartedAt: new Date() });
  assert.equal((await request(app).post(`/api/companies/${c._id}/research`)).status, 409);
  await Company.updateOne({ _id: c._id }, { researchStartedAt: new Date(Date.now() - 10 * 60_000) });
  assert.equal((await request(app).post(`/api/companies/${c._id}/research`)).status, 202);
  await service.onIdle();
  await Company.updateOne({ _id: c._id }, { researchStatus: 'running', researchStartedAt: new Date() });
  assert.equal(await service.recoverInterrupted(), 1);
  const after = await get(c._id);
  assert.equal(after.researchStatus, 'failed');
  assert.equal(after.researchError.code, 'interrupted');
  assert.equal(after.researchError.retryable, true);
});

t('research needs a website and a valid id', async () => {
  const noSite = await make({ website: '' });
  assert.equal((await request(app).post(`/api/companies/${noSite._id}/research`)).status, 400);
  assert.equal((await request(app).post('/api/companies/nope/research')).status, 400);
  assert.equal((await request(app).post(`/api/companies/${new mongoose.Types.ObjectId()}/research`)).status, 404);
});

t('failures store a safe error and keep earlier findings; retry succeeds and clears the error', async () => {
  const c = await make();
  await research(c._id);
  const before = (await get(c._id)).findings.length;
  routes['/'] = { status: 503, body: 'down' };
  await research(c._id);
  const failed = await get(c._id);
  assert.equal(failed.researchStatus, 'failed');
  assert.deepEqual(Object.keys(failed.researchError).sort(), ['code', 'message', 'retryable']);
  assert.equal(failed.researchError.retryable, true);
  assert.equal(failed.findings.length, before, 'a failed run must not delete findings');
  assert.ok(failed.findings.every((f) => f.seenInLatestRun !== false));
  routes['/'] = page(NAV);
  await research(c._id);
  const ok = await get(c._id);
  assert.equal(ok.researchStatus, 'researched');
  assert.equal(ok.researchError, undefined);
});

t('private and internal websites fail without leaking addresses', async () => {
  const strict = createResearchService({ config: { ...researchConfig, minIntervalMs: 0 } }); // production fetcher rules
  const strictApp = createApp({ research: strict });
  const c = (await request(strictApp).post('/api/companies').send({ name: 'X', website: 'http://example.com' })).body;
  await Company.updateOne({ _id: c._id }, { website: 'http://169.254.169.254/latest/meta-data/' }); // bypass input normalisation on purpose
  await request(strictApp).post(`/api/companies/${c._id}/research`);
  await strict.onIdle();
  const after = (await request(strictApp).get(`/api/companies/${c._id}`)).body;
  assert.equal(after.researchStatus, 'failed');
  assert.equal(after.researchError.code, 'blocked_host');
  assert.ok(!JSON.stringify(after.researchError).includes('169.254'));
  assert.equal(after.findings.length, 0);
});

// ---------- manual values are preserved ----------

t('research never overwrites manual or verified values; accepting a conflicting finding needs explicit overwrite', async () => {
  const c = await make({ careersUrl: 'https://manual.example/jobs', contactEmail: 'me@mine.example', hasRelevantRoles: 'no', fundingStatus: 'bootstrapped', fundingVerified: true });
  await research(c._id);
  const after = await get(c._id);
  assert.deepEqual(
    [after.careersUrl, after.contactEmail, after.hasRelevantRoles, after.fundingStatus, after.fundingVerified],
    ['https://manual.example/jobs', 'me@mine.example', 'no', 'bootstrapped', true]
  );

  const careers = find(after, 'careers');
  const blocked = await decide(c._id, careers._id, { action: 'accept' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'conflict');
  assert.equal(blocked.body.conflict.current, 'https://manual.example/jobs');
  assert.equal((await get(c._id)).careersUrl, 'https://manual.example/jobs');

  const email = find(after, 'email');
  assert.equal((await decide(c._id, email._id, { action: 'accept' })).status, 409);

  const funding = find(after, 'funding');
  assert.equal((await decide(c._id, funding._id, { action: 'accept' })).status, 409, 'verified funding is protected');

  const forced = await decide(c._id, careers._id, { action: 'accept', overwrite: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.careersUrl, `${base}/careers`);
  assert.equal(forced.body.careersSourceUrl, `${base}/`);
  assert.equal(forced.body.careersVerified, true);
  assert.equal(find(forced.body, 'careers').status, 'accepted');
});

t('accepting roles adds them with sources, and never flips a manual "no relevant roles"', async () => {
  const c = await make({ hasRelevantRoles: 'no' });
  await research(c._id);
  const doc = await get(c._id);
  const role = find(doc, 'role', (f) => /Backend/.test(f.title));
  const r = await decide(c._id, role._id, { action: 'accept' });
  assert.equal(r.status, 200);
  assert.equal(r.body.hasRelevantRoles, 'no');
  assert.deepEqual(r.body.openRoles.map((x) => [x.title, x.url, x.sourceUrl]), [['Backend Engineer', `${base}/careers/be`, `${base}/careers`]]);
  // accepting again is idempotent
  assert.equal((await decide(c._id, role._id, { action: 'accept' })).body.openRoles.length, 1);

  const c2 = await make({ name: 'Other' });
  await research(c2._id);
  const d2 = await get(c2._id);
  const r2 = await decide(c2._id, find(d2, 'role')._id, { action: 'accept' });
  assert.equal(r2.body.hasRelevantRoles, 'yes'); // only when it was "unknown"
});

t('accepting an edited email keeps the edit and drops the research source', async () => {
  const c = await make();
  await research(c._id);
  const email = find(await get(c._id), 'email');
  const r = await decide(c._id, email._id, { action: 'accept', value: 'Recruiting@Fixture.test' });
  assert.equal(r.body.contactEmail, 'recruiting@fixture.test');
  assert.equal(r.body.contactEmailSourceUrl, '');
  assert.equal((await decide(c._id, email._id + '', { action: 'accept', value: 'not-an-email' })).status, 200); // already accepted: no-op
  const c2 = await make({ name: 'Two' });
  await research(c2._id);
  const e2 = find(await get(c2._id), 'email');
  assert.equal((await decide(c2._id, e2._id, { action: 'accept', value: 'not-an-email' })).status, 400);
  const plain = await decide(c2._id, e2._id, { action: 'accept' });
  assert.equal(plain.body.contactEmailSourceUrl, `${base}/contact`);
});

t('accepting a funding lead records the company claim with its source but never marks it verified', async () => {
  const c = await make();
  await research(c._id);
  const f = find(await get(c._id), 'funding');
  const r = await decide(c._id, f._id, { action: 'accept' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.body.fundingStatus, r.body.fundingStage, r.body.fundingAmount, r.body.fundingDate, r.body.fundingSourceUrl, r.body.fundingVerified],
    ['funded', 'seed', '$3M', 'May 2024', `${base}/press`, false]
  );
});

t('rejected findings are not re-proposed; accepted ones are untouched; vanished ones are flagged', async () => {
  const c = await make();
  await research(c._id);
  let doc = await get(c._id);
  const email = find(doc, 'email');
  const role = find(doc, 'role', (f) => /Backend/.test(f.title));
  await decide(c._id, email._id, { action: 'reject' });
  await decide(c._id, find(doc, 'careers')._id, { action: 'accept' });
  const total = doc.findings.length;
  const firstSeen = find(doc, 'careers').observedAt;

  await new Promise((r) => setTimeout(r, 20));
  routes['/careers'] = page('<a href="/careers/ml">Machine Learning Engineer</a>'); // the backend role disappeared
  await research(c._id);
  doc = await get(c._id);
  assert.equal(doc.findings.length, total, 'no duplicates and nothing deleted');
  assert.equal(find(doc, 'email').status, 'rejected');
  assert.equal(find(doc, 'careers').status, 'accepted');
  assert.ok(new Date(find(doc, 'careers').observedAt) > new Date(firstSeen), 'observation time is refreshed');
  assert.equal(find(doc, 'role', (f) => f._id === role._id).seenInLatestRun, false);
  assert.equal(find(doc, 'role', (f) => /Machine/.test(f.title)).seenInLatestRun, true);
  assert.equal(doc.careersUrl, `${base}/careers`); // accepted value stays applied
});

t('decisions: reject/reset, accepted findings cannot be rejected, bulk decisions, bad input', async () => {
  const c = await make();
  await research(c._id);
  const doc = await get(c._id);
  const careers = find(doc, 'careers');
  assert.equal((await decide(c._id, careers._id, { action: 'reject' })).body.findings.find((f) => f._id === careers._id).status, 'rejected');
  assert.equal((await decide(c._id, careers._id, { action: 'reset' })).body.findings.find((f) => f._id === careers._id).status, 'pending');
  await decide(c._id, careers._id, { action: 'accept' });
  assert.equal((await decide(c._id, careers._id, { action: 'reject' })).status, 400);
  assert.equal((await decide(c._id, careers._id, { action: 'explode' })).status, 400);
  assert.equal((await decide('bad', careers._id, { action: 'accept' })).status, 400);
  assert.equal((await decide(c._id, new mongoose.Types.ObjectId().toString(), { action: 'accept' })).status, 404);

  const ids = doc.findings.filter((f) => f.kind === 'role').map((f) => f._id);
  const bulk = await request(app).post(`/api/companies/${c._id}/findings`).send({ action: 'accept', ids });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.changed, ids.length);
  assert.equal(bulk.body.company.openRoles.length, ids.length);
  assert.equal((await request(app).post(`/api/companies/${c._id}/findings`).send({ action: 'accept', ids: ['x'] })).status, 400);
});

t('hand-editing a researched value drops its research source and verified flag', async () => {
  const c = await make();
  await research(c._id);
  await decide(c._id, find(await get(c._id), 'careers')._id, { action: 'accept' });
  await decide(c._id, find(await get(c._id), 'email')._id, { action: 'accept' });
  const same = await request(app).patch(`/api/companies/${c._id}`).send({ careersUrl: `${base}/careers`, notes: 'x' });
  assert.equal(same.body.careersVerified, true, 'unchanged value keeps its provenance');
  const edited = await request(app).patch(`/api/companies/${c._id}`).send({ careersUrl: 'https://manual.example/jobs', contactEmail: 'me@mine.example' });
  assert.deepEqual([edited.body.careersSourceUrl, edited.body.careersVerified, edited.body.contactEmailSourceUrl], ['', false, '']);
});

// ---------- batch ----------

t('batch research queues several companies, skips unusable ones, and enforces limits', async () => {
  const a = await make({ name: 'A' });
  const b = await make({ name: 'B' });
  const none = await make({ name: 'No site', website: '' });
  await Company.updateOne({ _id: b._id }, { researchStatus: 'running', researchStartedAt: new Date() });
  const r = await request(app).post('/api/research/batch').send({ ids: [a._id, b._id, none._id, new mongoose.Types.ObjectId().toString()] });
  assert.equal(r.status, 202);
  assert.deepEqual(r.body.started, [a._id]);
  assert.deepEqual(r.body.skipped.map((s) => s.reason).sort(), ['already running', 'no website', 'not found']);
  await service.onIdle();
  assert.equal((await get(a._id)).researchStatus, 'researched');

  assert.equal((await request(app).post('/api/research/batch').send({ ids: [] })).status, 400);
  assert.equal((await request(app).post('/api/research/batch').send({ ids: ['nope'] })).status, 400);
  const many = Array.from({ length: researchConfig.batchLimit + 1 }, () => new mongoose.Types.ObjectId().toString());
  assert.equal((await request(app).post('/api/research/batch').send({ ids: many })).status, 400);
});

t('research config is exposed, statuses filter, and "not found" counts as researched in stats', async () => {
  const cfg = (await request(app).get('/api/research/config')).body;
  assert.ok(cfg.roleKeywords.includes('engineer') && cfg.maxPages >= 1);
  routes['/'] = page('<p>nothing here</p>');
  const c = await make();
  await research(c._id);
  assert.equal((await get(c._id)).researchStatus, 'not_found');
  assert.deepEqual((await get(c._id)).researchNotFound.sort(), ['careers', 'email']);
  assert.equal((await request(app).get('/api/stats')).body.researched, 1);
  assert.equal((await request(app).get('/api/companies?researchStatus=not_found')).body.total, 1);
});
