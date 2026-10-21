import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanies, normalizeUrl, domainOf, normalizeFundingStage, normalizeFundingStatus } from '../src/lib/csv.js';
import { buildFilter } from '../src/lib/filters.js';
import { cleanPatch } from '../src/app.js';
import * as cheerio from 'cheerio';
import { findEmails, findRoles } from '../src/lib/research.js';

test('normalizes urls and domains', () => {
  assert.equal(normalizeUrl('example.com/'), 'https://example.com');
  assert.equal(domainOf('https://www.Example.com/path'), 'example.com');
  assert.equal(normalizeUrl('not a url'), '');
  assert.equal(normalizeUrl(''), '');
});

test('funding normalization never invents funding', () => {
  assert.equal(normalizeFundingStatus(''), 'unknown');
  assert.equal(normalizeFundingStatus('Yes'), 'funded');
  assert.equal(normalizeFundingStage('Series A'), 'series-a');
  assert.equal(normalizeFundingStage('Pre-Seed'), 'pre-seed');
  assert.equal(normalizeFundingStage(''), 'unknown');
});

test('free-text funding values are not misread as funded/bootstrapped', () => {
  for (const v of ['Yet to raise', 'Not sure', 'Not funded', 'yc', 'TBD']) assert.equal(normalizeFundingStatus(v), 'unknown', v);
  assert.equal(normalizeFundingStatus('No'), 'bootstrapped');
  assert.equal(normalizeFundingStatus('VC-backed'), 'funded');
});

test('parses CSV, maps headers, keeps unmapped columns, reports bad rows', () => {
  const r = parseCompanies('﻿Company Name,Website,Location,Industry,Notes,Founder\nAcme,acme.io,India,AI,hi,Bob\n,x.com,,,,\n');
  assert.equal(r.companies.length, 1);
  assert.equal(r.companies[0].domain, 'acme.io');
  assert.deepEqual(r.companies[0].extra, { Founder: 'Bob' });
  assert.equal(r.errors.length, 1);
});

test('rejects CSV without a name column', () => {
  assert.throws(() => parseCompanies('Foo,Bar\n1,2\n'), /No company name column/);
});

test('filter builder escapes regex and ANDs conditions', () => {
  const f = buildFilter({ q: 'a.b(', fundingStatus: 'funded', location: 'India' });
  assert.equal(f.fundingStatus, 'funded');
  assert.ok(f.$or[0].name.test('xa.b(y'));
  assert.ok(!f.$or[0].name.test('axb('));
  assert.ok(f.location.test('Bangalore, India'));
});

test('cleanPatch validates input and whitelists fields', () => {
  assert.throws(() => cleanPatch({ appStatus: 'Nope' }), /Invalid status/);
  assert.throws(() => cleanPatch({ contactEmail: 'bad' }), /not valid/);
  assert.throws(() => cleanPatch({ name: ' ' }), /required/);
  const p = cleanPatch({ website: 'foo.com', appStatus: 'Applied', evil: 1, followUpDate: '' });
  assert.equal(p.domain, 'foo.com');
  assert.equal(p.followUpDate, null);
  assert.ok(!('evil' in p));
});

test('research extractors only return observed same-domain/generic emails and role links', () => {
  const $ = cheerio.load('<body><a href="mailto:Careers@acme.io">x</a> reach bob@gmail.com or hello@acme.io <a href="/jobs/1">Backend Engineer</a><a href="/about">About</a></body>');
  assert.deepEqual(findEmails($, 'acme.io').sort(), ['careers@acme.io', 'hello@acme.io']);
  assert.deepEqual(findRoles($, 'https://acme.io'), [{ title: 'Backend Engineer', url: 'https://acme.io/jobs/1' }]);
});

test('roles ignore blog/video links; emails are not glued to neighbouring text', () => {
  const $ = cheerio.load('<body><p>Questions</p><p>hello@acme.io</p><a href="https://youtube.com/x">Engineer talk</a><a href="/blog/eng">Engineering blog</a><a href="https://jobs.lever.co/acme/1">Software Engineer</a></body>');
  assert.deepEqual(findEmails($, 'acme.io'), ['hello@acme.io']);
  assert.deepEqual(findRoles($, 'https://acme.io').map((r) => r.title), ['Software Engineer']);
});
