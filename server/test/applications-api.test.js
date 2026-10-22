// Application tracking against a real MongoDB (test DB only). Skipped, loudly, if MongoDB is unreachable.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { NO_LIMITS } from './helpers/limits.js';
import Company from '../src/models/Company.js';
import Application from '../src/models/Application.js';
import { createApplicationService } from '../src/lib/applicationService.js';

const URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/startup-finder-test-apps';
if (!/test/i.test(new URL(URI).pathname)) throw new Error('Refusing to run API tests against a non-test database');

let up = false;
let app;
before(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000 });
    up = true;
    await Application.init();
    app = createApp({ limits: NO_LIMITS });
  } catch {
    console.warn(`SKIPPING application API tests: cannot reach MongoDB at ${URI}`);
  }
});
after(async () => {
  if (up) await mongoose.disconnect();
});
beforeEach(async () => {
  if (up) await Promise.all([Company.deleteMany({}), Application.deleteMany({})]);
});

const t = (name, fn) => test(name, async (ctx) => (up ? fn(ctx) : ctx.skip('MongoDB not available')));
const ymd = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const company = async (extra = {}) => (await request(app).post('/api/companies').send({ name: 'Acme', website: 'acme.io', ...extra })).body;
const addApp = (cid, body) => request(app).post(`/api/companies/${cid}/applications`).send(body);
const getCompany = async (id) => (await request(app).get(`/api/companies/${id}`)).body;
const listApps = async (cid) => (await request(app).get(`/api/companies/${cid}/applications`)).body.items;
const patchApp = (id, body) => request(app).patch(`/api/applications/${id}`).send(body);
const types = (a) => a.history.map((h) => h.type);

// ---------- create and edit ----------

t('creates an application with every field, a creation history entry, and updates the company summary', async () => {
  const c = await company();
  const r = await addApp(c._id, {
    role: 'Backend Intern', jobUrl: 'https://www.acme.io/jobs/1?utm_source=x', status: 'Applied', appliedDate: ymd(-3), lastContactDate: ymd(-1),
    followUpDate: ymd(5), contactName: 'Priya', contactEmail: 'priya@acme.io', contactUrl: 'linkedin.com/in/priya', nextAction: 'Email Priya', notes: 'Referred by Sam',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'Applied');
  assert.equal(r.body.jobUrl, 'https://www.acme.io/jobs/1?utm_source=x');
  assert.equal(r.body.contactUrl, 'https://linkedin.com/in/priya');
  assert.ok(r.body.createdAt && r.body.updatedAt);
  assert.equal(r.body.history[0].type, 'created');
  const co = await getCompany(c._id);
  assert.deepEqual([co.applicationCount, co.appStatus, co.appStatuses], [1, 'Applied', ['Applied']]);
  assert.equal(co.appliedDate.slice(0, 10), ymd(-3));
  assert.equal(co.followUpDate.slice(0, 10), ymd(5));
  assert.equal(co.lastContactDate.slice(0, 10), ymd(-1));
});

t('a new application defaults to To Apply; a general (role-less) application is allowed', async () => {
  const c = await company();
  const r = await addApp(c._id, { role: '' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'To Apply');
  assert.equal(r.body.role, '');
});

t('editing updates fields, bumps updatedAt, and rejects bad input without changing anything', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'AI Intern' })).body;
  await new Promise((res) => setTimeout(res, 15));
  const ok = await patchApp(a._id, { notes: 'Spoke to recruiter', nextAction: 'Send portfolio', contactName: 'Lee', jobUrl: 'acme.io/jobs/9' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.notes, ok.body.nextAction, ok.body.jobUrl], ['Spoke to recruiter', 'Send portfolio', 'https://acme.io/jobs/9']);
  assert.ok(new Date(ok.body.updatedAt) > new Date(a.updatedAt));

  const cases = [
    [{ jobUrl: 'not a url' }, /web address/], [{ appliedDate: '2026-02-31' }, /real date/], [{ appliedDate: ymd(10) }, /future/],
    [{ status: 'Hired' }, /Invalid status/], [{ contactEmail: 'x' }, /email/], [{ role: { $ne: 1 } }, /text/], [{ followUpDate: 'soon' }, /real date/],
  ];
  for (const [body, re] of cases) {
    const r = await patchApp(a._id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  const after = (await listApps(c._id))[0];
  assert.deepEqual([after.notes, after.status, after.role], ['Spoke to recruiter', 'To Apply', 'AI Intern']);
  assert.equal((await request(app).patch('/api/applications/nope').send({})).status, 400);
  assert.equal((await patchApp(new mongoose.Types.ObjectId().toString(), { notes: 'x' })).status, 404);
});

t('create validation: bad URL, date, status, type, unknown company', async () => {
  const c = await company();
  for (const body of [{ jobUrl: 'ftp//x' }, { appliedDate: '31/12/2025' }, { status: 'Maybe' }, { role: 5 }, { followUpDate: '2026-13-01' }]) {
    assert.equal((await addApp(c._id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await addApp(new mongoose.Types.ObjectId().toString(), { role: 'X' })).status, 404);
  assert.equal((await addApp('nope', {})).status, 400);
  assert.equal(await Application.countDocuments(), 0);
});

// ---------- multiple roles ----------

t('several roles at one company keep independent statuses; the company shows the furthest and every status', async () => {
  const c = await company();
  const be = (await addApp(c._id, { role: 'Backend Intern', status: 'Applied' })).body;
  const ai = (await addApp(c._id, { role: 'AI Engineer Intern', status: 'To Apply' })).body;
  const sre = (await addApp(c._id, { role: 'SRE Intern', status: 'Rejected' })).body;
  let co = await getCompany(c._id);
  assert.deepEqual([co.applicationCount, co.appStatus], [3, 'Applied']);
  assert.deepEqual(co.appStatuses.sort(), ['Applied', 'Rejected', 'To Apply']);

  await patchApp(ai._id, { status: 'Interview' });
  co = await getCompany(c._id);
  assert.equal(co.appStatus, 'Interview');
  const apps = Object.fromEntries((await listApps(c._id)).map((a) => [a.role, a.status]));
  assert.deepEqual(apps, { 'Backend Intern': 'Applied', 'AI Engineer Intern': 'Interview', 'SRE Intern': 'Rejected' });

  // finishing one role does not drag the others along
  await patchApp(be._id, { status: 'Offer' });
  await patchApp(sre._id, { status: 'To Apply' });
  assert.equal((await listApps(c._id)).find((a) => a.role === 'AI Engineer Intern').status, 'Interview');
  assert.equal((await getCompany(c._id)).appStatus, 'Offer');

  // the company list filter finds the company under every status one of its applications has
  for (const s of ['Offer', 'Interview', 'To Apply']) assert.equal((await request(app).get(`/api/companies?appStatus=${encodeURIComponent(s)}`)).body.total, 1, s);
  for (const s of ['Applied', 'Rejected', 'Replied']) assert.equal((await request(app).get(`/api/companies?appStatus=${s}`)).body.total, 0, s);
});

t('the same role at different companies is fine', async () => {
  const a = await company({ name: 'A', website: 'a.io' });
  const b = await company({ name: 'B', website: 'b.io' });
  assert.equal((await addApp(a._id, { role: 'Backend Intern' })).status, 201);
  assert.equal((await addApp(b._id, { role: 'Backend Intern' })).status, 201);
});

t('removing an application refreshes the summary; removing the last one resets it', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'A', status: 'Interview', followUpDate: ymd(3) })).body;
  const b = (await addApp(c._id, { role: 'B', status: 'Applied' })).body;
  assert.equal((await request(app).delete(`/api/applications/${a._id}`)).status, 204);
  let co = await getCompany(c._id);
  assert.deepEqual([co.applicationCount, co.appStatus, co.followUpDate], [1, 'Applied', null]);
  await request(app).delete(`/api/applications/${b._id}`);
  co = await getCompany(c._id);
  assert.deepEqual([co.applicationCount, co.appStatus, co.appStatuses], [0, 'Not Applied', []]);
  assert.equal((await request(app).delete(`/api/applications/${b._id}`)).status, 404);
});

t('deleting a company removes its applications', async () => {
  const c = await company();
  await addApp(c._id, { role: 'A' });
  await addApp(c._id, { role: 'B' });
  assert.equal((await request(app).delete(`/api/companies/${c._id}`)).status, 204);
  assert.equal(await Application.countDocuments(), 0);
});

// ---------- duplicates ----------

t('duplicate applications are refused with the existing one identified', async () => {
  const c = await company();
  const first = (await addApp(c._id, { role: 'Backend Intern', jobUrl: 'https://acme.io/jobs/7' })).body;
  for (const body of [
    { role: ' backend   INTERN ' }, { role: 'Backend Intern!' }, { role: 'Other Title', jobUrl: 'http://www.acme.io/jobs/7/?utm_campaign=z#x' },
  ]) {
    const r = await addApp(c._id, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(r.body.code, 'duplicate_application');
    assert.equal(r.body.existing._id, first._id);
  }
  // a general application can exist only once per company
  assert.equal((await addApp(c._id, {})).status, 201);
  assert.equal((await addApp(c._id, { role: '' })).status, 409);
  assert.equal(await Application.countDocuments(), 2);
});

t('two identical requests at the same moment create only one application', async () => {
  const c = await company();
  const rs = await Promise.all([1, 2, 3, 4].map(() => addApp(c._id, { role: 'Backend Intern', status: 'Applied' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal(await Application.countDocuments(), 1);
  assert.equal((await getCompany(c._id)).applicationCount, 1);
});

t('renaming a role or URL into a duplicate is refused; the original is unchanged', async () => {
  const c = await company();
  await addApp(c._id, { role: 'Backend Intern', jobUrl: 'https://acme.io/jobs/1' });
  const other = (await addApp(c._id, { role: 'AI Intern' })).body;
  const r1 = await patchApp(other._id, { role: 'backend intern' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'duplicate_application');
  assert.equal((await patchApp(other._id, { jobUrl: 'https://acme.io/jobs/1/' })).status, 409);
  assert.equal((await listApps(c._id)).find((a) => a._id === other._id).role, 'AI Intern');
  assert.equal((await patchApp(other._id, { role: 'AI Engineer Intern' })).status, 200);
});

// ---------- status transitions and history ----------

t('status transitions fill dates, never erase them, and each change is in the history', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'Backend Intern' })).body;
  let r = await patchApp(a._id, { status: 'Applied' });
  assert.equal(r.body.appliedDate.slice(0, 10), ymd());
  r = await patchApp(a._id, { status: 'Replied' });
  assert.equal(r.body.lastContactDate.slice(0, 10), ymd());
  r = await patchApp(a._id, { status: 'Interview' });
  r = await patchApp(a._id, { status: 'To Apply' }); // moving back is allowed and keeps the dates
  assert.equal(r.body.appliedDate.slice(0, 10), ymd());
  assert.equal(r.body.lastContactDate.slice(0, 10), ymd());
  assert.deepEqual(r.body.history.filter((h) => h.type === 'status').map((h) => `${h.from}>${h.to}`), ['To Apply>Applied', 'Applied>Replied', 'Replied>Interview', 'Interview>To Apply']);
  assert.equal(r.body.history.filter((h) => h.type === 'applied').length, 1);
  assert.equal((await patchApp(a._id, { status: 'To Apply' })).body.history.length, r.body.history.length, 'a no-op adds nothing');
  assert.equal((await patchApp(a._id, { status: 'Bogus' })).status, 400);
});

t('activity history records applied dates, follow-up changes, contact, details and manual notes', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'Backend Intern', status: 'Applied', appliedDate: ymd(-5) })).body;
  await patchApp(a._id, { followUpDate: ymd(3) });
  await patchApp(a._id, { followUpDate: ymd(10) });
  await patchApp(a._id, { followUpDate: null });
  await patchApp(a._id, { lastContactDate: ymd(-1) });
  await patchApp(a._id, { appliedDate: ymd(-6) });
  await patchApp(a._id, { role: 'Backend Engineer Intern' });
  await patchApp(a._id, { notes: 'a private note' }); // not logged
  const n = await request(app).post(`/api/applications/${a._id}/activity`).send({ note: 'Emailed Priya' });
  assert.equal(n.status, 201);
  const h = (await listApps(c._id))[0].history;
  assert.deepEqual(h.map((x) => x.type), ['created', 'followUp', 'followUp', 'followUp', 'contact', 'applied', 'details', 'note']);
  assert.match(h[1].summary, /Follow-up set for/);
  assert.match(h[2].summary, /moved/);
  assert.match(h[3].summary, /cleared/);
  assert.equal(h.at(-1).summary, 'Emailed Priya');
  assert.ok(h.every((x) => x.at && x.summary));
  assert.equal((await request(app).post(`/api/applications/${a._id}/activity`).send({ note: '   ' })).status, 400);
  assert.equal((await request(app).post(`/api/applications/${a._id}/activity`).send({ note: 'x'.repeat(501) })).status, 400);
  assert.equal((await request(app).post(`/api/applications/${a._id}/activity`).send({ note: { a: 1 } })).status, 400);
});

// ---------- follow-ups ----------

t('overdue and due follow-ups are listed, counted and filterable; finished applications never count', async () => {
  const c1 = await company({ name: 'One', website: 'one.io' });
  const c2 = await company({ name: 'Two', website: 'two.io' });
  const c3 = await company({ name: 'Three', website: 'three.io' });
  await addApp(c1._id, { role: 'Overdue', status: 'Applied', appliedDate: ymd(-10), followUpDate: ymd(-4) });
  await addApp(c1._id, { role: 'Today', status: 'Replied', followUpDate: ymd() });
  await addApp(c2._id, { role: 'Later', status: 'Applied', followUpDate: ymd(7) });
  await addApp(c2._id, { role: 'Rejected', status: 'Rejected', appliedDate: ymd(-40), followUpDate: ymd(-30) });
  await addApp(c3._id, { role: 'Offer', status: 'Offer', appliedDate: ymd(-40), followUpDate: ymd(-30) });

  const due = (await request(app).get('/api/applications?followUpDue=true')).body;
  assert.deepEqual(due.items.map((a) => a.role), ['Overdue', 'Today']);
  assert.deepEqual(due.items.map((a) => [a.companyName, a.overdue, a.daysOverdue]), [['One', true, 4], ['One', false, 0]]);
  const stats = (await request(app).get('/api/stats')).body;
  assert.deepEqual([stats.followUpsDue, stats.followUpsOverdue], [2, 1]);
  const filtered = (await request(app).get('/api/companies?followUpDue=true')).body;
  assert.deepEqual(filtered.items.map((c) => c.name), ['One']);
  assert.equal((await request(app).get('/api/applications?followUpDue=true&status=Rejected')).body.items.length, 0);
  assert.equal((await request(app).get('/api/applications?status=Nonsense')).status, 400);
  // Operator-style query keys are not interpreted: they neither filter nor break anything.
  const injected = await request(app).get('/api/applications?status[$ne]=x');
  assert.equal(injected.status, 200);
  assert.equal(injected.body.total, 5);
  assert.equal((await request(app).get('/api/applications?limit=1')).body.items.length, 1);
});

t('the company follow-up is the earliest open one and changes as applications finish', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'A', status: 'Applied', followUpDate: ymd(2) })).body;
  await addApp(c._id, { role: 'B', status: 'Applied', followUpDate: ymd(9) });
  assert.equal((await getCompany(c._id)).followUpDate.slice(0, 10), ymd(2));
  await patchApp(a._id, { status: 'Rejected' });
  assert.equal((await getCompany(c._id)).followUpDate.slice(0, 10), ymd(9));
});

t('moving an overdue application forward works and keeps its (still overdue) reminder', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'Backend Intern', status: 'To Apply', followUpDate: ymd(-3) })).body;
  const r = await patchApp(a._id, { status: 'Interview' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.appliedDate.slice(0, 10), ymd());
  assert.equal(r.body.followUpDate.slice(0, 10), ymd(-3));
  assert.equal((await addApp(c._id, { role: 'SRE Intern', status: 'Applied', followUpDate: ymd(-2) })).status, 201);
});

t('a follow-up before the applied date is refused', async () => {
  const c = await company();
  assert.equal((await addApp(c._id, { role: 'A', status: 'Applied', appliedDate: ymd(-2), followUpDate: ymd(-5) })).status, 400);
  const a = (await addApp(c._id, { role: 'B', status: 'Applied', appliedDate: ymd(-2) })).body;
  const r = await patchApp(a._id, { followUpDate: ymd(-9) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /before the applied date/);
});

// ---------- compatibility with company-level fields ----------

t('company-level status edits act on the single application, create one if none, and refuse when there are several', async () => {
  const c = await company();
  let r = await request(app).patch(`/api/companies/${c._id}`).send({ appStatus: 'Applied', followUpDate: ymd(4) });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.appStatus, r.body.applicationCount], ['Applied', 1]);
  assert.equal(r.body.followUpDate.slice(0, 10), ymd(4));
  const [only] = await listApps(c._id);
  assert.deepEqual([only.role, only.status], ['', 'Applied']);
  assert.ok(only.history.some((h) => h.type === 'created'));

  r = await request(app).patch(`/api/companies/${c._id}`).send({ appStatus: 'Interview' });
  assert.equal(r.body.appStatus, 'Interview');
  assert.equal((await listApps(c._id)).length, 1);
  assert.ok((await listApps(c._id))[0].history.some((h) => h.type === 'status' && h.to === 'Interview'));

  await addApp(c._id, { role: 'Second role' });
  r = await request(app).patch(`/api/companies/${c._id}`).send({ appStatus: 'Rejected' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'multiple_applications');
  assert.equal((await getCompany(c._id)).appStatus, 'Interview');
  // other company fields can still be edited
  assert.equal((await request(app).patch(`/api/companies/${c._id}`).send({ location: 'Berlin' })).status, 200);
});

t('company-level "Not Applied" with no dates does not create an application', async () => {
  const c = await company();
  await request(app).patch(`/api/companies/${c._id}`).send({ appStatus: 'Not Applied' });
  assert.equal(await Application.countDocuments(), 0);
});

// ---------- notes survive imports and updates ----------

t('company and application notes survive an import with the update policy', async () => {
  const csv = 'Company,Website,Notes,Location\nAcme,acme.io,,Berlin\n';
  const first = await request(app).post('/api/import').attach('file', Buffer.from(csv), { filename: 'a.csv', contentType: 'text/csv' });
  assert.equal(first.status, 200);
  const [c] = (await request(app).get('/api/companies')).body.items;
  await request(app).patch(`/api/companies/${c._id}`).send({ notes: 'Company-level note' });
  await addApp(c._id, { role: 'Backend Intern', status: 'Applied', notes: 'Application note', followUpDate: ymd(3) });

  const again = 'Company,Website,Notes,Application Status,Applied Date,Follow-up Date\nAcme,acme.io,csv note,Rejected,2020-01-01,2020-01-02\n';
  const r = await request(app).post('/api/import').field('policy', 'update').attach('file', Buffer.from(again), { filename: 'b.csv', contentType: 'text/csv' });
  assert.equal(r.status, 200);
  const co = (await request(app).get(`/api/companies/${c._id}`)).body;
  assert.equal(co.notes, 'Company-level note');
  assert.deepEqual([co.appStatus, co.applicationCount], ['Applied', 1]);
  const [a] = await listApps(c._id);
  assert.deepEqual([a.notes, a.status, a.followUpDate.slice(0, 10)], ['Application note', 'Applied', ymd(3)]);
  assert.equal(await Application.countDocuments(), 1);
});

t('imported status and date columns become one application; re-importing creates no duplicates', async () => {
  const csv = 'Company,Website,Application Status,Applied Date,Follow-up Date\nAcme,acme.io,Applied,2026-10-01,2026-10-20\nBeta,beta.org,,,\n';
  const send = () => request(app).post('/api/import').attach('file', Buffer.from(csv), { filename: 'a.csv', contentType: 'text/csv' });
  assert.equal((await send()).body.summary.created, 2);
  assert.equal(await Application.countDocuments(), 1);
  const [a] = await Application.find().lean();
  assert.deepEqual([a.status, a.role, a.appliedDate.toISOString().slice(0, 10), a.followUpDate.toISOString().slice(0, 10)], ['Applied', '', '2026-10-01', '2026-10-20']);
  assert.equal(a.history[0].type, 'created');
  await send();
  assert.equal(await Application.countDocuments(), 1);
  const acme = (await request(app).get('/api/companies?q=acme')).body.items[0];
  assert.deepEqual([acme.appStatus, acme.applicationCount], ['Applied', 1]);
});

// ---------- migration ----------

t('migration converts company-level tracking into applications without inventing or losing data, and is idempotent', async () => {
  const col = Company.collection;
  const raw = (o) => ({ name: 'X', website: '', domain: '', notes: '', extra: {}, ...o });
  const ids = {};
  for (const [k, o] of Object.entries({
    full: { name: 'Full', appStatus: 'Interview', appliedDate: new Date('2026-09-01'), followUpDate: new Date('2026-10-30'), contactName: 'Priya', contactEmail: 'p@full.io', notes: 'keep this note' },
    dateOnly: { name: 'DateOnly', appStatus: 'Not Applied', followUpDate: new Date('2026-11-05') },
    noDates: { name: 'NoDates', appStatus: 'Applied' },
    nothing: { name: 'Nothing', appStatus: 'Not Applied' },
  })) ids[k] = (await col.insertOne(raw(o))).insertedId;

  // Before migrating, the status filter already works for these older records.
  assert.equal((await request(app).get('/api/companies?appStatus=Interview')).body.total, 1);

  const svc = createApplicationService();
  assert.deepEqual(await svc.migrateAll(), { candidates: 3, created: 3 });
  const full = (await Application.find({ company: ids.full }).lean())[0];
  assert.deepEqual([full.role, full.status, full.appliedDate.toISOString().slice(0, 10), full.followUpDate.toISOString().slice(0, 10), full.contactName, full.contactEmail], ['', 'Interview', '2026-09-01', '2026-10-30', 'Priya', 'p@full.io']);
  assert.equal(full.history[0].type, 'migrated');
  assert.ok(!full.lastContactDate, 'no last-contact date is invented');
  const noDates = (await Application.find({ company: ids.noDates }).lean())[0];
  assert.ok(!noDates.appliedDate && noDates.status === 'Applied', 'no applied date is invented');
  assert.equal((await Application.find({ company: ids.dateOnly }).lean())[0].status, 'Not Applied');
  assert.equal(await Application.countDocuments({ company: ids.nothing }), 0);

  const c = await getCompany(ids.full);
  assert.deepEqual([c.notes, c.appStatus, c.applicationCount, c.appStatuses], ['keep this note', 'Interview', 1, ['Interview']]);
  assert.deepEqual(await svc.migrateAll(), { candidates: 0, created: 0 });
  assert.equal(await Application.countDocuments(), 3);
});

// ---------- export ----------

t('applications export is a guarded, readable CSV including the activity history', async () => {
  const c = await company();
  await addApp(c._id, { role: '=SUM(A1)', status: 'Applied', notes: '+1 phone, "quoted"\nsecond line' });
  const res = await request(app).get('/api/applications/export').buffer(true).parse((r, cb) => { let d = ''; r.setEncoding('utf8'); r.on('data', (x) => (d += x)); r.on('end', () => cb(null, d)); });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.ok(res.body.startsWith('﻿Company,Role,Job URL,Status,'));
  assert.ok(res.body.includes("'=SUM(A1)") && res.body.includes("'+1 phone"));
  assert.ok(res.body.includes('Application added as ""Applied""'));
  assert.equal((await Application.findOne().lean()).role, '=SUM(A1)'); // stored value untouched
});

// ---------- persistence ----------

t('everything persists across a server restart (new connection, new app instance)', async () => {
  const c = await company();
  const a = (await addApp(c._id, { role: 'Backend Intern', status: 'Applied', notes: 'persist me', followUpDate: ymd(6), contactName: 'Priya' })).body;
  await patchApp(a._id, { status: 'Interview' });
  await request(app).post(`/api/applications/${a._id}/activity`).send({ note: 'Phone screen booked' });
  const before = (await listApps(c._id))[0];
  const companyBefore = await getCompany(c._id);

  // "Restart": drop the connection and the app, then bring up a fresh connection and app.
  await mongoose.disconnect();
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 3000 });
  await Application.init();
  app = createApp({ limits: NO_LIMITS });

  const after = (await listApps(c._id))[0];
  assert.deepEqual(after, before);
  assert.equal(after.history.length, before.history.length);
  assert.deepEqual(types(after), ['created', 'status', 'note']);
  assert.deepEqual(await getCompany(c._id), companyBefore);
  // The startup migration finds nothing to do and duplicate protection still holds.
  assert.deepEqual(await createApplicationService().migrateAll(), { candidates: 0, created: 0 });
  assert.equal((await addApp(c._id, { role: 'backend intern' })).status, 409);
});
