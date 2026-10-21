import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, ImportError } from '../src/lib/csvParse.js';
import { suggestMapping, validateMapping, normalizeRow, planImport, parseDate, nameKey } from '../src/lib/importer.js';
import { buildCsv } from '../src/lib/exportCsv.js';

const buf = (s) => Buffer.from(s, 'utf8');

let nextId = 1;
const existingDoc = (o = {}) => ({
  _id: `id${nextId++}`, name: 'X', website: '', domain: '', location: '', industry: '',
  fundingStatus: 'unknown', fundingStage: 'unknown', fundingSourceUrl: '', fundingVerified: false,
  careersUrl: '', careersSourceUrl: '', careersVerified: false, contactEmail: '', contactEmailSourceUrl: '',
  contactName: '', hasRelevantRoles: 'unknown', openRoles: [], researchStatus: 'not_researched',
  appStatus: 'Not Applied', notes: '', extra: {}, ...o,
});

function run(csv, existing = [], opts = {}) {
  const parsed = parseCsv(buf(csv));
  const mapping = opts.mapping ?? suggestMapping(parsed.headers, parsed.records);
  const plan = planImport({ existing, records: parsed.records, mapping, headers: parsed.headers, ...opts });
  return { parsed, mapping, plan };
}

// ---------- parsing ----------

test('parses quoted commas, escaped quotes, embedded newlines, unicode, BOM and blanks', () => {
  const csv = '﻿Company,Website,Notes\n"Acme, Inc.",acme.io,"He said ""hi""\nsecond line"\nZürich Labs 東京,zl.ch,\n  Padded  ,  pad.io  ,  x  \n';
  const { headers, records } = parseCsv(buf(csv));
  assert.deepEqual(headers, ['Company', 'Website', 'Notes']);
  assert.equal(records.length, 3);
  assert.equal(records[0].values.Company, 'Acme, Inc.');
  assert.equal(records[0].values.Notes, 'He said "hi"\nsecond line');
  assert.equal(records[1].values.Company, 'Zürich Labs 東京');
  assert.equal(records[1].values.Notes, '');
  assert.equal(records[2].values.Company, 'Padded');
});

test('handles rows with fewer or more cells than headers, blank rows, and semicolon files', () => {
  const r = parseCsv(buf('Company,Website,Notes\nA,a.io\nB,b.io,n,surplus\n,,\nC,c.io,x\n'));
  assert.equal(r.records.length, 3);
  assert.equal(r.blankRows, 1);
  assert.equal(r.records[0].values.Notes, '');
  assert.deepEqual(r.records[1].overflow, ['surplus']);
  const semi = parseCsv(buf('Company;Website\nA;a.io\n'));
  assert.equal(semi.delimiter, ';');
  assert.equal(semi.records[0].values.Website, 'a.io');
});

test('rejects malformed, binary, empty and non-UTF-8 files with ImportError', () => {
  assert.throws(() => parseCsv(buf('Company,Notes\nA,"unterminated\n')), (e) => e instanceof ImportError && /Malformed CSV/.test(e.message));
  assert.throws(() => parseCsv(Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80])), ImportError);
  assert.throws(() => parseCsv(buf('a,b\u0000\n1,2\n')), /binary/);
  assert.throws(() => parseCsv(buf('')), /empty/);
  assert.throws(() => parseCsv(buf('Company,Website\n')), /at least one data row/);
  assert.throws(() => parseCsv(buf('Company,Website\n,\n,\n')), /no data rows/);
  assert.throws(() => parseCsv(buf('A,B\n1,"bad"quote\n')), ImportError);
});

test('duplicate and empty headers are made unique', () => {
  const { headers } = parseCsv(buf('Name,Name,,Notes\na,b,c,d\n'));
  assert.deepEqual(headers, ['Name', 'Name (2)', 'Column 3', 'Notes']);
});

// ---------- mapping ----------

test('maps common header aliases automatically', () => {
  const headers = ['Startup', 'URL', 'Funding', 'Funding Stage', 'Industry', 'Location', 'Careers', 'Email', 'Job Title', 'Notes', 'Founder'];
  const m = suggestMapping(headers);
  assert.equal(m.Startup, 'name');
  assert.equal(m.URL, 'website');
  assert.equal(m.Funding, 'fundingStatus');
  assert.equal(m['Funding Stage'], 'fundingStage');
  assert.equal(m.Careers, 'careersUrl');
  assert.equal(m.Email, 'contactEmail');
  assert.equal(m['Job Title'], 'jobTitle');
  assert.equal(m.Notes, 'notes');
  assert.equal(m.Founder, 'extra');
  assert.equal(suggestMapping(['Company Name'])['Company Name'], 'name');
});

test('only the first of two columns claims a field; a bare Status column is guarded', () => {
  const m = suggestMapping(['Company', 'Company Name', 'Website', 'Domain']);
  assert.equal(m.Company, 'name');
  assert.equal(m['Company Name'], 'extra');
  assert.equal(m.Domain, 'extra');
  const funding = parseCsv(buf('Company,Status\nA,Series A raised\nB,Hot\n'));
  assert.equal(suggestMapping(funding.headers, funding.records).Status, 'extra');
  const app = parseCsv(buf('Company,Status\nA,Applied\nB,interview\n'));
  assert.equal(suggestMapping(app.headers, app.records).Status, 'appStatus');
});

test('validateMapping requires a name column and rejects double-mapped targets', () => {
  const h = ['A', 'B'];
  assert.match(validateMapping({ A: 'website', B: 'ignore' }, h), /company name/);
  assert.match(validateMapping({ A: 'name', B: 'name' }, h), /both mapped/);
  assert.match(validateMapping({ A: 'name', C: 'extra' }, h), /not in the file/);
  assert.match(validateMapping({ A: 'name', B: 'bogus' }, h), /Unknown target/);
  assert.equal(validateMapping({ A: 'name', B: 'ignore' }, h), null);
});

// ---------- row normalisation ----------

test('rows without a company name fail with a clear reason', () => {
  const { plan } = run('Company,Website\n,x.io\nOk,ok.io\n  ,y.io\n');
  assert.equal(plan.created, 1);
  assert.deepEqual(plan.failed.map((f) => [f.row, f.error]), [[2, 'Missing company name'], [4, 'Missing company name']]);
  assert.equal(plan.failed[0].data.Website, 'x.io');
});

test('unusable values are kept in extra data with a warning instead of being dropped', () => {
  const { plan } = run('Company,Website,Email,Funding,Applied Date\nA,N/A,hiring at a dot com,Yet to raise,03/04/2026\nB,b.io,,Series A,2026-02-31\n');
  const [a, b] = plan.toInsert;
  assert.equal(a.website, undefined);
  assert.equal(a.extra['Website (original)'], 'N/A');
  assert.equal(a.extra['Email (original)'], 'hiring at a dot com');
  assert.equal(a.extra['Funding (original)'], 'Yet to raise');
  assert.equal(a.fundingStatus, undefined);
  assert.equal(a.extra['Applied Date (original)'], '03/04/2026');
  assert.equal(b.fundingStage, 'series-a');
  assert.equal(b.fundingStatus, undefined);
  assert.equal(b.extra['Applied Date (original)'], '2026-02-31');
  assert.ok(plan.warnings.length >= 5);
});

test('dates: only unambiguous ISO dates are accepted', () => {
  assert.equal(parseDate('2026-10-05').toISOString(), '2026-10-05T00:00:00.000Z');
  assert.ok(parseDate('2026-10-05T10:20:30Z'));
  for (const bad of ['10/05/2026', 'Oct 5 2026', '2026-02-31', '2026-13-01', '']) assert.equal(parseDate(bad), null, bad);
});

test('cells with the export formula-guard apostrophe are restored', () => {
  const { plan } = run("Company,Notes\n'+Plus Co,'=1+1\n");
  assert.equal(plan.toInsert[0].name, '+Plus Co');
  assert.equal(plan.toInsert[0].notes, '=1+1');
});

test('Job Title is stored as an unverified role and never sets relevant-roles', () => {
  const { plan } = run('Company,Job Title\nA,Backend Engineer\n');
  assert.deepEqual(plan.toInsert[0].openRoles, [{ title: 'Backend Engineer', url: '' }]);
  assert.equal(plan.toInsert[0].hasRelevantRoles, undefined);
});

// ---------- duplicates ----------

test('normal import creates every valid row', () => {
  const { plan } = run('Company,Website,Industry\nAcme,acme.io,AI\nBeta,https://www.beta.org/,Security\n');
  assert.equal(plan.created, 2);
  assert.equal(plan.toInsert[1].domain, 'beta.org');
  assert.equal(plan.duplicates.length, 0);
});

test('importing the same file twice creates nothing the second time', () => {
  const csv = 'Company,Website\nAcme,acme.io\nBeta,beta.org\nNoSite,\n';
  const first = run(csv).plan;
  assert.equal(first.created, 3);
  const stored = first.toInsert.map((d) => existingDoc(d));
  const second = run(csv, stored).plan;
  assert.equal(second.created, 0);
  assert.equal(second.skipped.length, 3);
  assert.equal(second.toInsert.length, 0);
  assert.equal(second.toUpdate.length, 0);
});

test('duplicates inside one file are skipped with the row that matched', () => {
  const { plan } = run('Company,Website\nAcme,acme.io\nACME Inc.,www.acme.io\nOther,other.io\n');
  assert.equal(plan.created, 2);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /row 2 of this file/);
  assert.equal(plan.duplicates[0].kind, 'domain');
});

test('similar names are NOT merged', () => {
  const stored = [existingDoc({ name: 'Acme', website: 'https://acme.io', domain: 'acme.io' })];
  const { plan } = run('Company,Website\nAcme Labs,acmelabs.io\nAcmeX,acmex.io\nAcme Robotics,\n', stored);
  assert.equal(plan.created, 3);
  assert.equal(plan.duplicates.length, 0);
  assert.notEqual(nameKey('Acme Labs'), nameKey('Acme'));
  assert.equal(nameKey('Acme, Inc.'), nameKey('ACME'));
});

test('same name with different websites is flagged but created by default', () => {
  const stored = [existingDoc({ name: 'Nova', website: 'https://nova.io', domain: 'nova.io' })];
  const { plan } = run('Company,Website\nNova,nova.ai\n', stored);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].kind, 'possible');
  assert.match(plan.duplicates[0].reason, /nova\.io vs nova\.ai/);
  assert.equal(plan.duplicates[0].action, 'create');
  assert.equal(plan.created, 1);
});

test('same name where one side has no website is a duplicate; shared hosts do not count as identity', () => {
  const stored = [existingDoc({ name: 'Nova' }), existingDoc({ name: 'Solo A', website: 'https://linkedin.com/company/a', domain: 'linkedin.com' })];
  const { plan } = run('Company,Website\nNova,nova.io\nSolo B,linkedin.com/company/b\n', stored);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].kind, 'name');
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.created, 1);
});

test('per-row decisions override the policy', () => {
  const stored = [existingDoc({ name: 'Acme', website: 'https://acme.io', domain: 'acme.io', location: '' })];
  const csv = 'Company,Website,Location\nAcme,acme.io,Berlin\n';
  assert.equal(run(csv, stored, { policy: 'skip' }).plan.updated, 0);
  assert.equal(run(csv, stored, { policy: 'update' }).plan.updated, 1);
  assert.equal(run(csv, stored, { policy: 'update', decisions: { 2: 'skip' } }).plan.updated, 0);
  const forced = run(csv, stored, { policy: 'skip', decisions: { 2: 'create' } }).plan;
  assert.equal(forced.created, 1);
});

// ---------- protected data ----------

test('update never overwrites application data, verified research or blanks it out', () => {
  const stored = [existingDoc({
    name: 'Acme', website: 'https://acme.io', domain: 'acme.io',
    notes: 'Spoke to Priya, strong lead', appStatus: 'Interview', contactName: 'Priya',
    appliedDate: new Date('2026-09-01'), followUpDate: new Date('2026-10-20'),
    fundingStatus: 'funded', fundingStage: 'seed', fundingVerified: true, fundingSourceUrl: 'https://news.example/acme',
    careersUrl: 'https://acme.io/careers', careersVerified: true, careersSourceUrl: 'https://acme.io',
    contactEmail: 'jobs@acme.io', contactEmailSourceUrl: 'https://acme.io/contact',
    hasRelevantRoles: 'yes', location: 'Berlin',
  })];
  const csv = [
    'Company,Website,Notes,Application Status,Contact Name,Applied Date,Follow-up Date,Funding Status,Funding Stage,Careers URL,Contact Email,Relevant Roles,Location',
    'Acme,acme.io,CSV note,Rejected,Someone Else,2026-01-01,2026-01-02,bootstrapped,series-b,https://other.io/jobs,x@y.io,no,Paris',
  ].join('\n');
  const { plan } = run(csv, stored, { policy: 'update' });
  const [u] = plan.toUpdate;
  assert.deepEqual(Object.keys(u.set), ['location']);
  assert.equal(u.set.location, 'Paris');
  const blanks = run('Company,Website,Notes,Application Status,Applied Date,Location\nAcme,acme.io,,,,\n', stored, { policy: 'update' }).plan;
  assert.equal(blanks.toUpdate.length, 0);
  assert.equal(blanks.updated, 0);
  assert.equal(blanks.skipped.length, 1);
});

test('update fills blanks and unverified funding, and adds new roles and extra columns', () => {
  const stored = [existingDoc({ name: 'Acme', website: 'https://acme.io', domain: 'acme.io', fundingStage: 'seed', extra: { Founder: 'Bob' } })];
  const csv = 'Company,Website,Notes,Funding Stage,Careers,Job Title,Founder,Source\nAcme,acme.io,fresh note,series-a,acme.io/careers,SRE,Alice,YC list\n';
  const { plan } = run(csv, stored, { policy: 'update' });
  const set = plan.toUpdate[0].set;
  assert.equal(set.notes, 'fresh note');
  assert.equal(set.fundingStage, 'series-a');
  assert.equal(set.careersUrl, 'https://acme.io/careers');
  assert.deepEqual(set.openRoles, [{ title: 'SRE', url: '' }]);
  assert.deepEqual(set.extra, { Founder: 'Bob', Source: 'YC list' });
});

test('status and dates from the CSV only fill an untouched record', () => {
  const stored = [existingDoc({ name: 'Acme', website: 'https://acme.io', domain: 'acme.io' })];
  const { plan } = run('Company,Website,Application Status,Applied Date\nAcme,acme.io,Applied,2026-10-01\n', stored, { policy: 'update' });
  assert.equal(plan.toUpdate[0].set.appStatus, 'Applied');
  assert.equal(plan.toUpdate[0].set.appliedDate.toISOString().slice(0, 10), '2026-10-01');
});

// ---------- export / re-import ----------

const sample = () => [
  {
    name: 'Zürich Labs 東京', website: 'https://zl.ch', domain: 'zl.ch', location: 'Zürich, CH', industry: 'AI',
    fundingStatus: 'funded', fundingStage: 'seed', fundingSourceUrl: 'https://news.example/zl', fundingVerified: true,
    careersUrl: 'https://zl.ch/careers', careersSourceUrl: 'https://zl.ch', careersVerified: true,
    contactEmail: 'jobs@zl.ch', contactEmailSourceUrl: 'https://zl.ch/contact', contactName: 'Anna, "AJ" Meier',
    hasRelevantRoles: 'yes', openRoles: [{ title: 'Backend Engineer', url: 'https://zl.ch/j/1' }, { title: 'SRE (EU)', url: 'https://zl.ch/j/2(copy)' }, { title: 'Intern', url: '' }],
    researchStatus: 'researched', researchedAt: new Date('2026-10-01T10:20:30.000Z'),
    appStatus: 'Applied', appliedDate: new Date('2026-10-02'), followUpDate: new Date('2026-10-09'),
    notes: 'Line one\nLine "two", with comma', extra: { Founder: 'Anna', Notes: 'clashes with standard column' },
  },
  {
    name: '+Plus Co', website: 'https://plus.io', domain: 'plus.io', notes: '=HYPERLINK("http://evil","x")', location: '@home',
    fundingStatus: 'unknown', fundingStage: 'unknown', hasRelevantRoles: 'unknown', researchStatus: 'not_researched',
    appStatus: 'Not Applied', openRoles: [], extra: {},
  },
];

test('export is escaped, prefixes formula cells, keeps unicode and does not mutate stored values', () => {
  const items = sample();
  const csv = buildCsv(items);
  assert.ok(csv.startsWith('﻿Company,'));
  assert.ok(csv.includes('Zürich Labs 東京'));
  assert.ok(csv.includes('"Anna, ""AJ"" Meier"'));
  assert.ok(csv.includes("'+Plus Co"));
  assert.ok(csv.includes(`'=HYPERLINK(""http://evil"",""x"")`));
  assert.ok(csv.includes("'@home"));
  assert.equal(items[1].name, '+Plus Co');
  assert.equal(items[1].notes, '=HYPERLINK("http://evil","x")');
});

test('export then re-import reproduces every field', () => {
  const items = sample();
  const parsed = parseCsv(buf(buildCsv(items)));
  const mapping = suggestMapping(parsed.headers, parsed.records);
  const { toInsert, failed, created } = planImport({ existing: [], records: parsed.records, mapping, headers: parsed.headers });
  assert.equal(failed.length, 0);
  assert.equal(created, 2);
  const [a, b] = toInsert;
  const [ea] = items;
  for (const f of ['name', 'website', 'domain', 'location', 'industry', 'fundingStatus', 'fundingStage', 'fundingSourceUrl', 'fundingVerified',
    'careersUrl', 'careersSourceUrl', 'careersVerified', 'contactEmail', 'contactEmailSourceUrl', 'contactName', 'hasRelevantRoles',
    'researchStatus', 'appStatus', 'notes']) {
    assert.deepEqual(a[f], ea[f], f);
  }
  assert.equal(a.researchedAt.getTime(), ea.researchedAt.getTime());
  assert.equal(a.appliedDate.getTime(), ea.appliedDate.getTime());
  assert.equal(a.followUpDate.getTime(), ea.followUpDate.getTime());
  assert.deepEqual(a.openRoles.map((r) => r.title), ['Backend Engineer', 'SRE (EU)', 'Intern']);
  // ")" in a URL is percent-encoded on export, which is the same URL.
  assert.equal(a.openRoles[1].url, 'https://zl.ch/j/2(copy%29');
  assert.equal(a.extra.Founder, 'Anna');
  assert.equal(a.extra.Notes, 'clashes with standard column');
  assert.equal(b.name, '+Plus Co');
  assert.equal(b.notes, '=HYPERLINK("http://evil","x")');
  assert.equal(b.location, '@home');
});

test('re-importing an export over the same data changes nothing', () => {
  const items = sample().map((d) => existingDoc(d));
  const parsed = parseCsv(buf(buildCsv(items)));
  const mapping = suggestMapping(parsed.headers, parsed.records);
  const plan = planImport({ existing: items, records: parsed.records, mapping, headers: parsed.headers, policy: 'update' });
  assert.equal(plan.created, 0);
  assert.equal(plan.toUpdate.length, 0);
});

test('client error-CSV builder escapes cells, guards formulas and keeps original columns', async () => {
  const { errorsToCsv } = await import('../../client/src/importCsv.js');
  const csv = errorsToCsv(['Company', 'Website'], [{ row: 4, error: 'Missing company name', data: { Company: '', Website: '=cmd, "x"' } }]);
  assert.ok(csv.startsWith('﻿Company,Website,Row,Error\r\n'));
  assert.ok(csv.includes(`,"'=cmd, ""x""",4,Missing company name`));
  const back = parseCsv(Buffer.from(csv.replace(/^﻿/, ''), 'utf8'));
  assert.equal(back.records[0].values.Error, 'Missing company name');
});
