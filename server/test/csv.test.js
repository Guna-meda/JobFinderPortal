import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, domainOf, normalizeFundingStage, normalizeFundingStatus } from '../src/lib/csv.js';
import { buildFilter } from '../src/lib/filters.js';
import { cleanPatch } from '../src/app.js';

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
