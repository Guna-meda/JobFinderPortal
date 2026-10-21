import { parse } from 'csv-parse/sync';

export const STATUSES = ['Not Applied', 'To Apply', 'Applied', 'Replied', 'Interview', 'Rejected', 'Offer'];
export const FUNDING_STATUSES = ['unknown', 'bootstrapped', 'funded'];
export const FUNDING_STAGES = ['unknown', 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c+', 'other'];

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// canonical field -> accepted header aliases (normalized)
const ALIASES = {
  name: ['companyname', 'company', 'name', 'startup', 'startupname'],
  website: ['website', 'websiteurl', 'url', 'domain', 'site', 'link'],
  location: ['location', 'city', 'country', 'hq', 'headquarters', 'region'],
  industry: ['industry', 'category', 'sector', 'vertical', 'tags'],
  fundingStatus: ['fundingstatus', 'funded', 'funding'],
  fundingStage: ['fundingstage', 'stage', 'round', 'lastround'],
  careersUrl: ['careersurl', 'careers', 'careerspage', 'jobsurl', 'jobs'],
  contactEmail: ['email', 'contactemail', 'publiccontactemail', 'hiringemail'],
  notes: ['notes', 'note', 'comments', 'description'],
  appStatus: ['applicationstatus', 'appstatus', 'status'],
};

export function mapHeaders(headers) {
  const map = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const h = headers.find((x) => !used.has(x) && aliases.includes(norm(x)));
    if (h) {
      map[field] = h;
      used.add(h);
    }
  }
  return map;
}

export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.includes('.')) return '';
    return u.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

export function normalizeFundingStatus(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return 'unknown';
  // Whole-value matches only: free text like "Yet to raise" or "Not sure" must stay unknown.
  if (/^(no|none|bootstrapped?|self[\s-]?funded)$/.test(s)) return 'bootstrapped';
  if (/^(yes|y|true|funded|vc[\s-]?backed|backed|raised)$/.test(s)) return 'funded';
  return 'unknown';
}

export function normalizeFundingStage(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/pre[\s-]?seed/.test(s)) return 'pre-seed';
  if (/seed/.test(s)) return 'seed';
  if (/series[\s-]?a\b|^a$/.test(s)) return 'series-a';
  if (/series[\s-]?b\b|^b$/.test(s)) return 'series-b';
  if (/series[\s-]?[c-z]|growth|ipo|late/.test(s)) return 'series-c+';
  if (/unknown|n\/a|^-$/.test(s)) return 'unknown';
  return 'other';
}

export function normalizeStatus(v) {
  const s = String(v || '').toLowerCase().trim();
  return STATUSES.find((x) => x.toLowerCase() === s) || 'Not Applied';
}

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Parse CSV text into normalized company drafts + row errors. Pure; no DB. */
export function parseCompanies(text) {
  let rows;
  try {
    rows = parse(text.replace(/^﻿/, ''), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (e) {
    throw new Error(`Could not parse CSV: ${e.message}`);
  }
  if (!rows.length) throw new Error('CSV has no data rows.');
  const headers = Object.keys(rows[0]);
  const map = mapHeaders(headers);
  if (!map.name) {
    throw new Error(
      `No company name column found. Headers seen: ${headers.join(', ')}. Expected one of: Company Name, Company, Name, Startup.`
    );
  }
  const mapped = new Set(Object.values(map));
  const companies = [];
  const errors = [];
  rows.forEach((r, i) => {
    const name = (r[map.name] || '').trim();
    if (!name) {
      errors.push({ row: i + 2, error: 'Missing company name' });
      return;
    }
    const website = normalizeUrl(r[map.website]);
    const extra = {};
    for (const h of headers) if (!mapped.has(h) && r[h]) extra[h] = r[h];
    companies.push({
      name,
      website,
      domain: domainOf(website),
      location: r[map.location] || '',
      industry: r[map.industry] || '',
      fundingStatus: normalizeFundingStatus(r[map.fundingStatus]),
      fundingStage: normalizeFundingStage(r[map.fundingStage]),
      careersUrl: normalizeUrl(r[map.careersUrl]),
      contactEmail: EMAIL_OK.test(r[map.contactEmail] || '') ? r[map.contactEmail] : '',
      notes: r[map.notes] || '',
      appStatus: normalizeStatus(r[map.appStatus]),
      extra,
    });
  });
  return { companies, errors, mapping: map, unmapped: headers.filter((h) => !mapped.has(h)) };
}
