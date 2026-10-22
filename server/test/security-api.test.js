// Security and data-quality regression tests against a real MongoDB (test DB only).
import test, { before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import Company from '../src/models/Company.js';
import Application from '../src/models/Application.js';
import Draft from '../src/models/Draft.js';
import { createApplicationService } from '../src/lib/applicationService.js';
import { checkIntegrity } from '../src/lib/integrity.js';
import { NO_LIMITS } from './helpers/limits.js';

const URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/startup-finder-test-security';
if (!/test/i.test(new URL(URI).pathname)) throw new Error('Refusing to run API tests against a non-test database');

let up = false;
let app;
let apps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAKS = /Cast to|for model|at path|mongoose|ValidationError|MongoServerError|node_modules|\bstack\b|\bat \S+\.js/i;

before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000 });
    up = true;
    await Application.init();
    apps = createApplicationService();
    app = createApp({ applications: apps, limits: NO_LIMITS });
  } catch {
    console.warn(`SKIPPING security API tests: cannot reach MongoDB at ${URI}`);
  }
});
after(async () => {
  mock.restoreAll();
  if (up) await mongoose.disconnect();
});
beforeEach(async () => {
  mock.restoreAll();
  if (up) await Promise.all([Company.deleteMany({}), Application.deleteMany({}), Draft.deleteMany({})]);
});

const t = (name, fn) => test(name, async (ctx) => (up ? fn(ctx) : ctx.skip('MongoDB not available')));
const company = async (extra = {}) => (await request(app).post('/api/companies').send({ name: 'Acme', website: 'acme.io', ...extra })).body;
const csvUpload = (csv, fields = {}, path = '/api/import') => {
  let r = request(app).post(path).attach('file', Buffer.from(csv), { filename: 'a.csv', contentType: 'text/csv' });
  for (const [k, v] of Object.entries(fields)) r = r.field(k, typeof v === 'string' ? v : JSON.stringify(v));
  return r;
};
const counts = async () => [await Company.countDocuments(), await Application.countDocuments(), await Draft.countDocuments()];

// ---------- NoSQL operators and wrong types on every write endpoint ----------

t('operator-style and wrongly typed values are refused on every write endpoint, change nothing, and leak nothing', async () => {
  const c = await company();
  const a = (await request(app).post(`/api/companies/${c._id}/applications`).send({ role: 'Backend Intern' })).body;
  const d = (await request(app).post(`/api/companies/${c._id}/drafts`).send({ purpose: 'internship_inquiry', subject: 'S', body: 'B' })).body;
  const snapshot = JSON.stringify([await Company.findById(c._id).lean(), await Application.findById(a._id).lean(), await Draft.findById(d._id).lean()]);
  const before = await counts();
  const ghost = new mongoose.Types.ObjectId().toString();
  const OP = { $ne: 'x' };
  const cases = [
    ['post', '/api/companies', { name: { $gt: '' } }], ['post', '/api/companies', { name: 'X', notes: OP }], ['post', '/api/companies', { name: 'X', appStatus: OP }],
    ['post', '/api/companies', []], ['post', '/api/companies', { name: 'X', website: { a: 1 } }],
    ...['name', 'location', 'industry', 'contactName', 'notes', 'website', 'careersUrl', 'fundingAmount'].map((k) => ['patch', `/api/companies/${c._id}`, { [k]: OP }]),
    ['patch', `/api/companies/${c._id}`, { name: ['a'] }], ['patch', `/api/companies/${c._id}`, { fundingVerified: OP }], ['patch', `/api/companies/${c._id}`, { fundingVerified: 'yes' }],
    ['patch', `/api/companies/${c._id}`, { followUpDate: { $gt: 0 } }], ['patch', `/api/companies/${c._id}`, { appliedDate: 5 }], ['patch', `/api/companies/${c._id}`, { hasRelevantRoles: { $in: ['yes'] } }],
    ['patch', `/api/companies/${c._id}`, { hasRelevantRoles: 'zzz' }], ['patch', `/api/companies/${c._id}`, { fundingStage: OP }], ['patch', `/api/companies/${c._id}`, { appStatus: OP }],
    ...['role', 'status', 'jobUrl', 'notes', 'followUpDate', 'appliedDate', 'contactEmail', 'contactName', 'nextAction'].flatMap((k) => [
      ['post', `/api/companies/${c._id}/applications`, { role: 'Other', [k]: k === 'status' ? OP : { $gt: '' } }],
      ['patch', `/api/applications/${a._id}`, { [k]: OP }],
    ]),
    ['post', `/api/companies/${c._id}/applications`, []], ['patch', `/api/applications/${a._id}`, []],
    ['post', `/api/applications/${a._id}/activity`, { note: OP }], ['post', `/api/applications/${a._id}/activity`, { note: ['x'] }],
    ...[{ purpose: OP }, { subject: OP }, { body: OP }, { applicationId: OP }, { generatedBy: OP }, { role: OP }, { facts: OP }, { facts: [{ label: OP, value: 'v', basis: 'you' }] }].map((o) => ['post', `/api/companies/${c._id}/drafts`, { purpose: 'internship_inquiry', subject: 'S2', body: 'B2', ...o }]),
    ['patch', `/api/drafts/${d._id}`, { subject: OP }], ['patch', `/api/drafts/${d._id}`, { body: ['x'] }],
    ['post', `/api/drafts/${d._id}/sent`, { sentAt: { $gt: 1 } }], ['post', `/api/drafts/${d._id}/sent`, { sentAt: ['2026-01-01'] }],
    ['post', '/api/outreach/generate', { companyId: OP, purpose: 'internship_inquiry' }], ['post', '/api/outreach/generate', { companyId: c._id, purpose: OP }],
    ['post', '/api/outreach/generate', { companyId: c._id, purpose: 'internship_inquiry', role: OP }], ['post', '/api/outreach/generate', { companyId: c._id, applicationId: OP, purpose: 'internship_inquiry' }],
    ['post', '/api/research/batch', { ids: [OP] }], ['post', '/api/research/batch', { ids: 'all' }], ['post', '/api/research/batch', { ids: [ghost, { $ne: null }] }],
    ['post', `/api/companies/${c._id}/findings`, { action: 'accept', ids: [OP] }], ['post', `/api/companies/${c._id}/findings`, { action: OP, ids: [ghost] }],
    ['post', `/api/companies/${c._id}/findings/${ghost}`, { action: OP }], ['post', `/api/companies/${c._id}/findings/${ghost}`, { action: 'accept', value: OP }],
  ];
  const bodies = [];
  for (const [method, url, body] of cases) {
    const r = await request(app)[method](url).send(body);
    assert.ok([400, 404, 409, 422].includes(r.status), `${method.toUpperCase()} ${url} ${JSON.stringify(body)} -> ${r.status}`);
    bodies.push(JSON.stringify(r.body));
  }
  assert.equal(bodies.length, cases.length);
  assert.ok(bodies.length > 60);
  for (const b of bodies) assert.ok(!LEAKS.test(b), b);
  assert.deepEqual(await counts(), before);
  assert.equal(JSON.stringify([await Company.findById(c._id).lean(), await Application.findById(a._id).lean(), await Draft.findById(d._id).lean()]), snapshot);
});

t('import options must be well formed: mapping, decisions, policy, dryRun', async () => {
  const csv = 'Company,Website\nAcme,acme.io\n';
  for (const [fields, re] of [
    [{ mapping: '{"$where":"1"}' }, /Mapping refers|Unknown target|company name/i], [{ mapping: '[1,2]' }, /object/i], [{ mapping: '{not json' }, /JSON/],
    [{ mapping: { Company: { $ne: 1 }, Website: 'website' } }, /Unknown target/], [{ decisions: '[1]' }, /object/], [{ decisions: '"x"' }, /object/], [{ policy: 'overwrite-everything' }, /policy/],
  ]) {
    const r = await csvUpload(csv, fields);
    assert.equal(r.status, 400, JSON.stringify(fields));
    assert.match(r.body.error, re);
    assert.ok(!LEAKS.test(JSON.stringify(r.body)));
  }
  assert.equal(await Company.countDocuments(), 0);
});

// ---------- query strings ----------

t('query-string operators and hostile search text are neutralised', async () => {
  await company();
  await company({ name: 'Beta', website: 'beta.io' });
  const all = (await request(app).get('/api/companies')).body.total;
  for (const qs of ['q[$ne]=x', 'location[$regex]=.*', 'appStatus[$ne]=x', 'industry[$gt]=', 'sort[$gt]=1', 'limit[$gt]=1', 'fundingStatus[$in][]=funded', 'followUpDue[$ne]=false']) {
    const r = await request(app).get(`/api/companies?${qs}`);
    assert.equal(r.status, 200, qs);
    assert.equal(r.body.total, all, `${qs} must not filter`);
  }
  assert.equal((await request(app).get('/api/companies?limit=999999&page=abc')).body.limit, 1000);
  assert.equal((await request(app).get('/api/companies?page=-3')).status, 200);
  // User text must never be used to look up properties of Object.prototype (this used to be a 500).
  for (const sort of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await request(app).get(`/api/companies?sort=${sort}`);
    assert.equal(r.status, 200, sort);
    assert.equal(r.body.total, all);
  }
  const started = Date.now();
  const redos = await request(app).get(`/api/companies?q=${encodeURIComponent('(a+)+$' + 'a'.repeat(5000))}&location=${encodeURIComponent('.*.*.*.*[')}`);
  assert.equal(redos.status, 200);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await request(app).get('/api/companies?q=' + encodeURIComponent('Beta'))).body.total, 1);
  assert.equal((await request(app).get('/api/companies?q=' + encodeURIComponent('.*'))).body.total, 0, 'regex characters are literal');
});

// ---------- sizes, types, messages ----------

t('field lengths and types are enforced, and error messages are generic', async () => {
  const c = await company();
  const cases = [
    [{ name: 'x'.repeat(201) }, /name is too long/], [{ notes: 'x'.repeat(10_001) }, /notes is too long/], [{ website: `https://a.io/${'x'.repeat(2100)}` }, /website is too long/],
    [{ location: 'x'.repeat(201) }, /location is too long/], [{ fundingVerified: 'true' }, /true or false/], [{ hasRelevantRoles: 'maybe' }, /relevant roles/], [{ name: '' }, /required/], [{ location: 5 }, /must be text/],
  ];
  for (const [body, re] of cases) {
    const r = await request(app).patch(`/api/companies/${c._id}`).send(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(r.body.error, re);
    assert.ok(!LEAKS.test(JSON.stringify(r.body)));
  }
  assert.equal((await request(app).patch(`/api/companies/${c._id}`).send({ notes: 'x'.repeat(10_000) })).status, 200);
  assert.equal((await request(app).patch(`/api/companies/${c._id}`).set('Content-Type', 'text/plain').send('name=Hacked')).status, 200, 'non-JSON bodies are ignored');
  assert.equal((await Company.findById(c._id).lean()).name, 'Acme');
});

// ---------- imports: concurrency, partial failure, hostile headers ----------

t('only one import writes at a time; a second concurrent import is told to wait', async () => {
  const csv = 'Company,Website\nAcme,acme.io\nBeta,beta.io\n';
  const real = Company.find.bind(Company);
  let first = true;
  mock.method(Company, 'find', (...args) => {
    const q = real(...args);
    if (!first) return q;
    first = false;
    return { lean: async () => { await sleep(400); return q.lean(); } }; // hold the first import inside its critical section
  });
  const a = csvUpload(csv).then((r) => r);
  await sleep(120);
  const b = await csvUpload(csv);
  assert.equal(b.status, 409);
  assert.equal(b.body.code, 'import_in_progress');
  const ra = await a;
  assert.equal(ra.status, 200);
  assert.equal(ra.body.summary.created, 2);
  mock.restoreAll();
  assert.equal(await Company.countDocuments(), 2);
  // the lock is released afterwards, and dry runs are never blocked
  assert.equal((await csvUpload(csv)).status, 200);
  assert.equal(await Company.countDocuments(), 2);
});

t('many simultaneous identical imports never create duplicates', async () => {
  const rows = ['Company,Website'];
  for (let i = 0; i < 300; i++) rows.push(`Co ${i},co${i}.example.io`);
  const rs = await Promise.all(Array.from({ length: 6 }, () => csvUpload(rows.join('\n'))));
  assert.ok(rs.every((r) => [200, 409].includes(r.status)), rs.map((r) => r.status).join(','));
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal(await Company.countDocuments(), 300);
  const dup = await Company.aggregate([{ $group: { _id: '$domain', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  assert.equal(dup.length, 0);
});

t('a database failure mid-import is reported honestly (how many were saved), the lock is released, and a re-run completes it', async () => {
  const rows = ['Company,Website'];
  for (let i = 0; i < 5; i++) rows.push(`Co ${i},co${i}.example.io`);
  const csv = rows.join('\n');
  mock.method(Company, 'insertMany', async () => { throw Object.assign(new Error('write failed mongodb://u:pw@10.0.0.1/db'), { insertedDocs: [{ _id: 1 }, { _id: 2 }] }); });
  const quietLog = console.error;
  console.error = () => {};
  let r;
  try { r = await csvUpload(csv); } finally { console.error = quietLog; }
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'partial_import');
  assert.match(r.body.error, /2 new companies were already saved/);
  assert.match(r.body.error, /Re-running the same file is safe/);
  assert.ok(!/pw|10\.0\.0\.1|mongodb:/.test(JSON.stringify(r.body)));
  mock.restoreAll();
  const again = await csvUpload(csv);
  assert.equal(again.status, 200);
  assert.equal(again.body.summary.created, 5);
  assert.equal(await Company.countDocuments(), 5);
  assert.equal((await csvUpload(csv)).body.summary.created, 0);
});

t('hostile CSV headers cannot pollute objects or lose data, and field names with dots or $ are stored safely', async () => {
  const csv = 'Company,__proto__,constructor,Founder.Name,$price,"=HYPERLINK(""http://x.example"",""click"")"\nAcme,pv,cv,Sam,10,formula\n';
  const prev = await csvUpload(csv, {}, '/api/import/preview');
  assert.equal(prev.status, 200);
  assert.deepEqual(prev.body.headers.slice(0, 3), ['Company', '__proto___', 'constructor_']);
  const r = await csvUpload(csv);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.created, 1);
  assert.equal({}.pv, undefined);
  assert.equal({}.polluted, undefined);
  const c = (await request(app).get('/api/companies')).body.items[0];
  const values = Object.values(c.extra);
  for (const v of ['pv', 'cv', 'Sam', '10', 'formula']) assert.ok(values.includes(v), `value ${v} was kept`);
  assert.equal(Object.keys(c.extra).length, 5);
  // Columns named after Object.prototype members are just ordinary extra columns.
  const proto = await csvUpload('Company,toString,valueOf,hasOwnProperty\nBeta,1,2,3\n');
  assert.equal(proto.status, 200, JSON.stringify(proto.body));
  assert.equal(proto.body.summary.created, 1);
  assert.equal(Object.keys(c.extra).length, 5);
});

// ---------- CSV formula injection ----------

t('exports guard formula-like cells everywhere, including header names, without changing stored values', async () => {
  const csv = 'Company,Website,Notes,"=HYPERLINK(""http://x.example"",""click"")",@SUM(A1)\n=cmd|\' /C calc\'!A0,acme.io,+1 555 0100,-2+3,@bad\n';
  assert.equal((await csvUpload(csv)).status, 200);
  const text = (await request(app).get('/api/export').buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => (d += x)); res.on('end', () => cb(null, d)); })).body;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0];
  assert.ok(header.includes(`"'=HYPERLINK(""http://x.example"",""click"")"`) || header.includes("'=HYPERLINK("), header);
  assert.ok(header.includes("'@SUM(A1)"));
  const row = lines.slice(1).join('\n');
  assert.ok(row.includes("'=cmd|") && row.includes("'+1 555 0100") && row.includes("'-2+3") && row.includes("'@bad"));
  const cells = text.replace(/^﻿/, '').split(/\r?\n/).flatMap((l) => l.split(','));
  assert.ok(!cells.some((x) => /^"?[=+\-@]/.test(x) && !x.startsWith("'") && !x.startsWith('"\'')), 'no cell starts with a formula character');
  const stored = (await Company.findOne().lean());
  assert.equal(stored.name, "=cmd|' /C calc'!A0");
  assert.equal(stored.notes, '+1 555 0100');
});

// ---------- duplicate requests ----------

t('saving the same draft twice in a row does not create two drafts', async () => {
  const c = await company();
  const body = { purpose: 'internship_inquiry', subject: 'Same subject', body: 'Same body' };
  const one = await request(app).post(`/api/companies/${c._id}/drafts`).send(body);
  const two = await request(app).post(`/api/companies/${c._id}/drafts`).send(body);
  assert.equal(one.status, 201);
  assert.equal(two.body._id, one.body._id);
  assert.equal(await Draft.countDocuments(), 1);
  assert.equal((await request(app).post(`/api/companies/${c._id}/drafts`).send({ ...body, body: 'Different body' })).status, 201);
  assert.equal(await Draft.countDocuments(), 2);
});

// ---------- consistency between companies, applications and drafts ----------

t('the integrity check reports problems, repairs summaries and dangling pointers, and never deletes records', async () => {
  const c = await company();
  const a = (await request(app).post(`/api/companies/${c._id}/applications`).send({ role: 'Backend Intern', status: 'Applied', followUpDate: '2099-01-01' })).body;
  const d = (await request(app).post(`/api/companies/${c._id}/drafts`).send({ purpose: 'internship_inquiry', subject: 'S', body: 'B', applicationId: a._id })).body;
  assert.equal((await checkIntegrity({ apps })).ok, true);

  const ghost = new mongoose.Types.ObjectId();
  await Company.updateOne({ _id: c._id }, { $set: { appStatus: 'Offer', applicationCount: 7 } }); // summary drifted
  await Application.collection.insertOne({ company: ghost, role: 'Orphan', roleKey: 'orphan', jobUrlKey: '', status: 'Applied', history: [] });
  await Draft.collection.insertOne({ company: ghost, purpose: 'internship_inquiry', subject: 'O', body: 'B', status: 'draft' });
  await Draft.updateOne({ _id: d._id }, { $set: { application: new mongoose.Types.ObjectId() } }); // points at nothing

  const found = await checkIntegrity({ apps });
  assert.equal(found.ok, false);
  assert.deepEqual([found.orphanApplications.count, found.orphanDrafts.count, found.summaryMismatches.count, found.draftsWithMissingApplication.count], [1, 1, 1, 1]);
  assert.equal(found.repaired, 0);
  assert.deepEqual(await counts(), [1, 2, 2], 'a report-only run changes nothing');
  assert.equal((await Company.findById(c._id).lean()).appStatus, 'Offer');

  const fixed = await checkIntegrity({ apps, repair: true });
  assert.equal(fixed.repaired, 2);
  const co = await Company.findById(c._id).lean();
  assert.deepEqual([co.appStatus, co.applicationCount], ['Applied', 1]);
  assert.equal((await Draft.findById(d._id).lean()).application, null);
  assert.deepEqual(await counts(), [1, 2, 2], 'repair never deletes: orphans stay for you to decide on');
  const after = await checkIntegrity({ apps });
  assert.deepEqual([after.orphanApplications.count, after.orphanDrafts.count, after.summaryMismatches.count, after.draftsWithMissingApplication.count], [1, 1, 0, 0]);
});

t('companies migrated from older data are not reported as inconsistent', async () => {
  await Company.collection.insertOne({ name: 'Legacy', website: '', domain: '', appStatus: 'Interview', extra: {}, notes: '' });
  assert.equal((await checkIntegrity({ apps })).summaryMismatches.count, 0);
  await apps.migrateAll();
  assert.equal((await checkIntegrity({ apps })).ok, true);
});
