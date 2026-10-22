// Route-level tests against a real MongoDB (test DB only). Skipped, loudly, if MongoDB is unreachable.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { NO_LIMITS } from './helpers/limits.js';
import Company from '../src/models/Company.js';
import Application from '../src/models/Application.js';

const URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/startup-finder-test';
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
    console.warn(`SKIPPING API tests: cannot reach MongoDB at ${URI}`);
  }
});
after(async () => {
  if (up) await mongoose.disconnect();
});
beforeEach(async () => {
  if (up) await Promise.all([Company.deleteMany({}), Application.deleteMany({})]);
});

const t = (name, fn) => test(name, async (ctx) => (up ? fn(ctx) : ctx.skip('MongoDB not available')));

const csvReq = (path, csv, { name = 'sheet.csv', fields = {} } = {}) => {
  let r = request(app).post(path).attach('file', Buffer.from(csv, 'utf8'), { filename: name, contentType: 'text/csv' });
  for (const [k, v] of Object.entries(fields)) r = r.field(k, typeof v === 'string' ? v : JSON.stringify(v));
  return r;
};
const importCsv = (csv, fields = {}) => csvReq('/api/import', csv, { fields });
const all = async () => (await request(app).get('/api/companies?limit=1000')).body.items;
const count = () => Company.countDocuments();

const SAMPLE = [
  'Company Name,Website,Location,Industry,Funding Stage,Notes',
  '"Acme, Inc.",acme.io,India,AI,Seed,"Line ""one""\nline two"',
  'Zürich Labs 東京,https://www.zl.ch/,Zürich,Robotics,,',
  ',nameless.io,,,,',
  'Beta,beta.org,Remote,Security,Series A,',
].join('\n');

t('rejects missing files and non-.csv files without touching the database', async () => {
  assert.equal((await request(app).post('/api/import')).status, 400);
  const r = await csvReq('/api/import', 'a,b\n1,2\n', { name: 'sheet.xlsx' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Only \.csv/);
  assert.equal(await count(), 0);
});

t('malformed or binary files return 400 and import nothing', async () => {
  for (const bad of ['Company,Notes\nA,"unterminated\n', 'Company\u0000,x\nA,1\n', '']) {
    const r = await importCsv(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.body.error);
  }
  assert.equal(await count(), 0);
});

t('oversized uploads return 413', async () => {
  const r = await request(app).post('/api/import').attach('file', Buffer.alloc(11 * 1024 * 1024, 'a'), { filename: 'big.csv', contentType: 'text/csv' });
  assert.equal(r.status, 413);
});

t('preview suggests a mapping and writes nothing', async () => {
  const r = await csvReq('/api/import/preview', SAMPLE);
  assert.equal(r.status, 200);
  assert.equal(r.body.rowCount, 4);
  assert.equal(r.body.suggestedMapping['Company Name'], 'name');
  assert.equal(r.body.suggestedMapping['Funding Stage'], 'fundingStage');
  assert.ok(r.body.fields.some((f) => f.key === 'jobTitle'));
  assert.equal(await count(), 0);
});

t('dry run reports the plan but does not write', async () => {
  const r = await importCsv(SAMPLE, { dryRun: 'true' });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.deepEqual([r.body.summary.created, r.body.summary.failed], [3, 1]);
  assert.equal(r.body.sample.length, 3);
  assert.equal(await count(), 0);
});

t('imports valid rows, reports the failed row with its data, and keeps quotes, newlines and unicode', async () => {
  const r = await importCsv(SAMPLE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.summary, { created: 3, updated: 0, skipped: 0, failed: 1, possibleDuplicates: 0, warnings: 0 });
  assert.equal(r.body.failed.items[0].row, 4);
  assert.equal(r.body.failed.items[0].error, 'Missing company name');
  assert.equal(r.body.failed.items[0].data.Website, 'nameless.io');
  const items = await all();
  const acme = items.find((c) => c.name === 'Acme, Inc.');
  assert.equal(acme.notes, 'Line "one"\nline two');
  assert.equal(acme.fundingStage, 'seed');
  assert.equal(acme.fundingStatus, 'unknown');
  assert.ok(items.some((c) => c.name === 'Zürich Labs 東京' && c.domain === 'zl.ch'));
});

t('importing the same file twice does not create duplicates', async () => {
  await importCsv(SAMPLE);
  const again = await importCsv(SAMPLE);
  assert.equal(again.body.summary.created, 0);
  assert.equal(again.body.summary.skipped, 3);
  assert.equal(await count(), 3);
});

t('policy=update never overwrites notes, status, dates or verified data, and blank cells change nothing', async () => {
  await importCsv('Company,Website,Notes\nAcme,acme.io,\n');
  const [acme] = await all();
  await request(app).patch(`/api/companies/${acme._id}`).send({ notes: 'Spoke to Priya', appStatus: 'Interview', followUpDate: '2026-11-01', fundingStatus: 'funded', fundingStage: 'seed', fundingVerified: true });
  const r = await importCsv(
    'Company,Website,Notes,Application Status,Follow-up Date,Funding Status,Funding Stage,Location\nAcme,acme.io,,,,bootstrapped,series-b,Paris\nAcme,acme.io,csv note,Rejected,2026-01-01,,,\n',
    { policy: 'update' }
  );
  assert.equal(r.status, 200);
  const after = (await all())[0];
  assert.equal(after.notes, 'Spoke to Priya');
  assert.equal(after.appStatus, 'Interview');
  assert.equal(after.followUpDate.slice(0, 10), '2026-11-01');
  assert.equal(after.fundingStatus, 'funded');
  assert.equal(after.fundingStage, 'seed');
  assert.equal(after.location, 'Paris');
  assert.equal(await count(), 1);
});

t('blank CSV cells never erase existing values even with the update policy', async () => {
  await importCsv('Company,Website,Location,Industry,Notes\nAcme,acme.io,Berlin,AI,keep me\n');
  const r = await importCsv('Company,Website,Location,Industry,Notes\nAcme,acme.io,,,\n', { policy: 'update' });
  assert.equal(r.body.summary.updated, 0);
  const [c] = await all();
  assert.deepEqual([c.location, c.industry, c.notes], ['Berlin', 'AI', 'keep me']);
});

t('possible duplicates are reported with a reason and can be skipped or created per row', async () => {
  await importCsv('Company,Website\nNova,nova.io\n');
  const csv = 'Company,Website\nNova,nova.ai\n';
  const dry = await importCsv(csv, { dryRun: 'true' });
  assert.equal(dry.body.summary.possibleDuplicates, 1);
  assert.match(dry.body.duplicates.items[0].reason, /nova\.io vs nova\.ai/);
  assert.equal(dry.body.duplicates.items[0].action, 'create');
  const skipped = await importCsv(csv, { decisions: { 2: 'skip' } });
  assert.equal(skipped.body.summary.skipped, 1);
  assert.equal(await count(), 1);
  await importCsv(csv);
  assert.equal(await count(), 2);
});

t('manual column mapping, ignore, and extra data are honoured', async () => {
  const csv = 'Org,Link,Secret,Founder\nAcme,acme.io,hide me,Bob\n';
  const mapping = { Org: 'name', Link: 'website', Secret: 'ignore', Founder: 'extra' };
  const r = await importCsv(csv, { mapping });
  assert.equal(r.body.summary.created, 1);
  const [c] = await all();
  assert.equal(c.name, 'Acme');
  assert.equal(c.domain, 'acme.io');
  assert.deepEqual(c.extra, { Founder: 'Bob' });
});

t('invalid mappings are rejected', async () => {
  const csv = 'A,B\nx,y\n';
  assert.equal((await importCsv(csv, { mapping: { A: 'website', B: 'ignore' } })).status, 400);
  assert.equal((await importCsv(csv, { mapping: { A: 'name', B: 'name' } })).status, 400);
  assert.equal((await importCsv(csv, { mapping: { A: 'name', Z: 'extra' } })).status, 400);
  assert.equal((await importCsv(csv, { policy: 'merge-everything' })).status, 400);
  assert.equal(await count(), 0);
});

t('unusable values are preserved in extra data, never invented or dropped', async () => {
  await importCsv('Company,Website,Funding\nA,N/A,Yet to raise\n');
  const [c] = await all();
  assert.equal(c.website, '');
  assert.equal(c.fundingStatus, 'unknown');
  assert.equal(c.extra['Website (original)'], 'N/A');
  assert.equal(c.extra['Funding (original)'], 'Yet to raise');
});

t('export honours filters, escapes cells, guards formulas and leaves stored values intact', async () => {
  await importCsv('Company,Website,Industry,Notes\n+Plus Co,plus.io,AI,"=1+1"\nOther,other.io,Security,plain\n');
  const res = await request(app).get('/api/export?industry=AI').buffer(true).parse((r, cb) => { let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.ok(res.body.startsWith('﻿Company,'));
  assert.ok(res.body.includes("'+Plus Co") && res.body.includes("'=1+1"));
  assert.ok(!res.body.includes('Other'));
  const stored = (await all()).find((c) => c.domain === 'plus.io');
  assert.equal(stored.name, '+Plus Co');
  assert.equal(stored.notes, '=1+1');
});

t('full round trip: export, wipe, re-import restores every field including user edits', async () => {
  await importCsv([
    'Company,Website,Location,Industry,Funding Stage,Notes,Founder',
    '"Acme, Inc.",acme.io,India,AI,Seed,"two\nlines, ""quoted""",Bob',
    'Zürich Labs 東京,zl.ch,Zürich,Robotics,,=danger,Anna',
  ].join('\n'));
  const acme = (await all()).find((c) => c.domain === 'acme.io');
  await request(app).patch(`/api/companies/${acme._id}`).send({
    appStatus: 'Applied', appliedDate: '2026-10-02', followUpDate: '2026-10-09', contactEmail: 'jobs@acme.io', contactName: 'Priya',
    careersUrl: 'https://acme.io/careers', fundingStatus: 'funded', fundingSourceUrl: 'https://news.example/acme', fundingVerified: true,
  });
  const strip = (c) => { const { _id, createdAt, updatedAt, __v, ...rest } = c; return rest; };
  const before = (await all()).map(strip).sort((a, b) => a.name.localeCompare(b.name));
  const csv = (await request(app).get('/api/export').buffer(true).parse((r, cb) => { let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); })).body;

  await Promise.all([Company.deleteMany({}), Application.deleteMany({})]);
  const re = await importCsv(csv);
  assert.equal(re.status, 200);
  assert.deepEqual([re.body.summary.created, re.body.summary.failed, re.body.summary.warnings], [2, 0, 0]);
  const afterItems = (await all()).map(strip).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(afterItems, before);

  const again = await importCsv(csv, { policy: 'update' });
  assert.equal(again.body.summary.created, 0);
  assert.equal(again.body.summary.updated, 0);
  assert.equal(await count(), 2);
});

t('a few thousand rows import correctly in one request', async () => {
  const rows = ['Company,Website,Industry'];
  for (let i = 0; i < 3000; i++) rows.push(`Co ${i},co${i}.example.io,Tag${i % 7}`);
  const started = Date.now();
  const r = await importCsv(rows.join('\n'));
  assert.equal(r.body.summary.created, 3000);
  assert.equal(await count(), 3000);
  assert.ok(Date.now() - started < 30000);
  const again = await importCsv(rows.join('\n'));
  assert.equal(again.body.summary.created, 0);
  assert.equal(again.body.summary.skipped, 3000);
});
