import {
  STATUSES,
  normalizeUrl,
  domainOf,
  normalizeFundingStatus,
  normalizeFundingStage,
} from './csv.js';

/** Target fields a CSV column can be mapped to. `extra` keeps the raw column; `ignore` drops it. */
export const FIELDS = [
  ['name', 'Company name (required)'],
  ['website', 'Website'],
  ['location', 'Location'],
  ['industry', 'Industry'],
  ['fundingStatus', 'Funding status'],
  ['fundingStage', 'Funding stage'],
  ['fundingAmount', 'Funding amount'],
  ['fundingDate', 'Funding date'],
  ['fundingSourceUrl', 'Funding source URL'],
  ['fundingVerified', 'Funding verified (yes/no)'],
  ['careersUrl', 'Careers URL'],
  ['careersSourceUrl', 'Careers source URL'],
  ['careersVerified', 'Careers verified (yes/no)'],
  ['contactEmail', 'Contact email'],
  ['contactEmailSourceUrl', 'Contact email source URL'],
  ['contactName', 'Contact name'],
  ['jobTitle', 'Job title (stored as an unverified role)'],
  ['hasRelevantRoles', 'Relevant roles (yes/no/unknown)'],
  ['openRoles', 'Open roles (title (url) | ...)'],
  ['researchStatus', 'Research status'],
  ['researchedAt', 'Researched at (date)'],
  ['appStatus', 'Application status'],
  ['appliedDate', 'Applied date'],
  ['followUpDate', 'Follow-up date'],
  ['notes', 'Notes'],
].map(([key, label]) => ({ key, label }));

const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));
export const TARGETS = new Set([...FIELD_KEYS, 'extra', 'ignore']);

const ALIASES = {
  name: ['company', 'companyname', 'name', 'startup', 'startupname', 'organization', 'organisation'],
  website: ['website', 'websiteurl', 'url', 'site', 'homepage', 'domain', 'weburl'],
  location: ['location', 'city', 'country', 'hq', 'headquarters', 'region'],
  industry: ['industry', 'category', 'sector', 'vertical', 'tags'],
  fundingStatus: ['fundingstatus', 'funded', 'funding'],
  fundingStage: ['fundingstage', 'stage', 'round', 'lastround', 'fundinground'],
  fundingAmount: ['fundingamount', 'amountraised', 'amount'],
  fundingDate: ['fundingdate', 'lastfundingdate'],
  fundingSourceUrl: ['fundingsourceurl', 'fundingsource'],
  fundingVerified: ['fundingverified'],
  careersUrl: ['careers', 'careersurl', 'careerspage', 'careerurl', 'jobsurl', 'jobspage'],
  careersSourceUrl: ['careerssourceurl'],
  careersVerified: ['careersverified'],
  contactEmail: ['email', 'contactemail', 'publiccontactemail', 'hiringemail', 'recruitingemail'],
  contactEmailSourceUrl: ['contactemailsourceurl'],
  contactName: ['contactname', 'contact', 'recruiter'],
  jobTitle: ['jobtitle', 'role', 'position', 'openrole', 'roletitle'],
  hasRelevantRoles: ['relevantroles', 'hasrelevantroles', 'engineeringroles'],
  openRoles: ['openroles'],
  researchStatus: ['researchstatus'],
  researchedAt: ['researchedat'],
  appStatus: ['applicationstatus', 'appstatus'],
  appliedDate: ['applieddate', 'dateapplied', 'applicationdate'],
  followUpDate: ['followupdate', 'followup', 'nextfollowup'],
  notes: ['notes', 'note', 'comments', 'description'],
};
const ALIAS_LOOKUP = Object.fromEntries(
  Object.entries(ALIASES).flatMap(([field, list]) => list.map((a) => [a, field]))
);

const normHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- cell parsing ----------

// Exported CSVs prefix cells starting with = + - @ with an apostrophe (formula-injection guard); undo it on the way in.
export const clean = (v) => {
  const s = String(v ?? '').trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
};

export function parseStatus(raw) {
  const k = normHeader(raw);
  return STATUSES.find((s) => normHeader(s) === k) || null;
}

export function parseBool(raw) {
  const s = String(raw).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'x'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return null;
}

// Only unambiguous ISO dates are accepted. 03/04/2026 could be March or April, so it is not guessed.
export function parseDate(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) return null;
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  const day = new Date(`${m[1]}T00:00:00Z`);
  return day.toISOString().slice(0, 10) === m[1] ? d : null; // rejects 2026-02-31
}

export function parseRoles(raw) {
  return String(raw)
    .split(/\s*\|\s*/)
    .map((p) => {
      const m = p.match(/^(.*?)\s*\((https?:\/\/[^)\s]+)\)$/);
      return m ? { title: m[1].trim(), url: m[2] } : { title: p.trim(), url: '' };
    })
    .filter((r) => r.title)
    .slice(0, 50);
}

const UNKNOWN_WORD = /^(unknown|n\/a|na|tbd|-)$/i;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------- mapping ----------

export function suggestMapping(headers, records = []) {
  const mapping = {};
  const taken = new Set();
  for (const h of headers) {
    const field = ALIAS_LOOKUP[normHeader(h)];
    if (field && !taken.has(field)) {
      mapping[h] = field;
      taken.add(field);
    } else {
      mapping[h] = 'extra';
    }
  }
  // A bare "Status" column is ambiguous. Treat it as application status only if every value is one.
  const statusHeader = headers.find((h) => normHeader(h) === 'status' && mapping[h] === 'extra');
  if (statusHeader && !taken.has('appStatus')) {
    const vals = records.map((r) => clean(r.values[statusHeader])).filter(Boolean);
    if (vals.length && vals.every(parseStatus)) mapping[statusHeader] = 'appStatus';
  }
  return mapping;
}

/** Returns an error string if the mapping is unusable, else null. */
export function validateMapping(mapping, headers) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return 'Mapping must be an object.';
  const used = new Map();
  for (const [h, t] of Object.entries(mapping)) {
    if (!headers.includes(h)) return `Mapping refers to a column that is not in the file: "${h}".`;
    if (!TARGETS.has(t)) return `Unknown target "${t}" for column "${h}".`;
    if (FIELD_KEYS.has(t)) {
      if (used.has(t)) return `Columns "${used.get(t)}" and "${h}" are both mapped to "${t}". Map one of them to "Keep as extra" or "Ignore".`;
      used.set(t, h);
    }
  }
  if (!used.has('name')) return 'Choose which column holds the company name.';
  return null;
}

// ---------- row normalisation ----------

export function normalizeRow(record, mapping, headers) {
  const doc = { extra: {} };
  const warnings = [];
  const keep = (header, raw, reason) => {
    doc.extra[`${header} (original)`] = raw;
    warnings.push(`${header}: "${raw}" ${reason}; kept in extra data instead.`);
  };

  for (const header of headers) {
    const target = mapping[header] ?? 'extra';
    const raw = clean(record.values[header]);
    if (!raw || target === 'ignore') continue;
    switch (target) {
      case 'extra':
        // Export renames extra columns that clash with a standard header; undo that so round trips are stable.
        doc.extra[header.replace(/ \(extra\)$/, '')] = raw;
        break;
      case 'website': {
        const u = normalizeUrl(raw);
        if (u) {
          doc.website = u;
          doc.domain = domainOf(u);
        } else keep(header, raw, 'is not a valid website');
        break;
      }
      case 'careersUrl':
      case 'careersSourceUrl':
      case 'contactEmailSourceUrl':
      case 'fundingSourceUrl': {
        const u = normalizeUrl(raw);
        if (u) doc[target] = u;
        else keep(header, raw, 'is not a valid URL');
        break;
      }
      case 'contactEmail':
        if (EMAIL_OK.test(raw)) doc.contactEmail = raw;
        else keep(header, raw, 'is not a valid email');
        break;
      case 'fundingStatus': {
        if (UNKNOWN_WORD.test(raw)) break;
        const s = normalizeFundingStatus(raw);
        if (s !== 'unknown') doc.fundingStatus = s;
        else {
          // Free text such as "Series A" in a Funding column: keep it as a stage, never as a status guess.
          const st = normalizeFundingStage(raw);
          if (st !== 'unknown' && st !== 'other') {
            doc.fundingStage = doc.fundingStage ?? st;
            doc.extra[`${header} (original)`] = raw;
          } else keep(header, raw, 'is not a recognised funding status');
        }
        break;
      }
      case 'fundingStage': {
        if (UNKNOWN_WORD.test(raw)) break;
        const st = normalizeFundingStage(raw);
        doc.fundingStage = st;
        if (st === 'other') doc.extra[`${header} (original)`] = raw;
        break;
      }
      case 'fundingVerified':
      case 'careersVerified': {
        const b = parseBool(raw);
        if (b === null) keep(header, raw, 'is not yes/no');
        else doc[target] = b;
        break;
      }
      case 'jobTitle':
        doc.openRoles = [...(doc.openRoles || []), { title: raw.slice(0, 200), url: '' }];
        break;
      case 'openRoles':
        doc.openRoles = [...(doc.openRoles || []), ...parseRoles(raw)];
        break;
      case 'hasRelevantRoles': {
        const s = raw.toLowerCase();
        if (['yes', 'no', 'unknown'].includes(s)) doc.hasRelevantRoles = s;
        else keep(header, raw, 'is not yes/no/unknown');
        break;
      }
      case 'researchStatus':
        if (['not_researched', 'researched', 'partial', 'not_found', 'failed'].includes(raw)) doc.researchStatus = raw;
        else keep(header, raw, 'is not a known research status');
        break;
      case 'appStatus': {
        const s = parseStatus(raw);
        if (s) doc.appStatus = s;
        else keep(header, raw, `is not one of ${STATUSES.join(', ')}`);
        break;
      }
      case 'researchedAt':
      case 'appliedDate':
      case 'followUpDate': {
        const d = parseDate(raw);
        if (d) doc[target] = d;
        else keep(header, raw, 'is not an ISO date (YYYY-MM-DD)');
        break;
      }
      default:
        doc[target] = raw; // name, location, industry, contactName, notes
    }
  }

  record.overflow.forEach((c, k) => {
    const v = clean(c);
    if (v) {
      doc.extra[`Unnamed column ${headers.length + k + 1}`] = v;
      warnings.push(`Row has more cells than headers; extra value "${v}" kept in extra data.`);
    }
  });

  if (!doc.name) return { error: 'Missing company name', warnings };
  if (doc.name.length > 200) return { error: 'Company name is longer than 200 characters', warnings };
  return { doc, warnings };
}

// ---------- duplicate matching ----------

// Sites that many unrelated companies point at; a shared domain there says nothing about identity.
const SHARED_DOMAINS = new Set([
  'linkedin.com', 'github.com', 'github.io', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'notion.site', 'notion.so', 'wellfound.com', 'angel.co', 'crunchbase.com', 'ycombinator.com',
  'producthunt.com', 'medium.com', 'linktr.ee', 'google.com', 'docs.google.com',
]);
const LEGAL_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|pvt|private|gmbh|plc|co)\b/gu;

export function nameKey(name) {
  const base = String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const stripped = base.replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return stripped || base || String(name).toLowerCase();
}

const usableDomain = (d) => (d && !SHARED_DOMAINS.has(d) ? d : '');

// ---------- merge (update) rules ----------

const PLACEHOLDER = {
  fundingStatus: 'unknown',
  fundingStage: 'unknown',
  appStatus: 'Not Applied',
  hasRelevantRoles: 'unknown',
  researchStatus: 'not_researched',
};
const blank = (f, v) =>
  v === undefined || v === null || v === '' || v === false || v === PLACEHOLDER[f] || (Array.isArray(v) && v.length === 0);

/**
 * Apply a CSV row to an existing record. Rules:
 *  - Blank CSV cells never change anything.
 *  - Application data (notes, status, dates, contact name), research data and URLs are only FILLED when empty.
 *  - Only location, industry and unverified funding status/stage may be overwritten by a different non-blank value.
 *  - Verified funding is never touched. The company name never changes.
 * Mutates entry.doc and returns the list of changed field names.
 */
export function mergeInto(entry, inc) {
  const cur = entry.doc;
  const changed = [];
  const set = (f, v) => {
    cur[f] = v;
    if (!changed.includes(f)) changed.push(f);
  };
  const fill = (f) => {
    if (!blank(f, inc[f]) && blank(f, cur[f])) set(f, inc[f]);
  };

  for (const f of ['contactName', 'notes', 'appStatus', 'appliedDate', 'followUpDate', 'hasRelevantRoles', 'researchStatus', 'researchedAt']) fill(f);
  if (!blank('website', inc.website) && blank('website', cur.website)) {
    set('website', inc.website);
    set('domain', inc.domain);
  }
  for (const f of ['location', 'industry']) {
    if (!blank(f, inc[f]) && inc[f] !== cur[f]) set(f, inc[f]);
  }
  if (!cur.fundingVerified) {
    for (const f of ['fundingStatus', 'fundingStage']) {
      if (!blank(f, inc[f]) && inc[f] !== cur[f]) set(f, inc[f]);
    }
    fill('fundingSourceUrl');
    fill('fundingAmount');
    fill('fundingDate');
    if (inc.fundingVerified) set('fundingVerified', true);
  }
  // Careers / contact email: fill when empty, or complete the source info when the value is identical.
  for (const [url, extras] of [
    ['careersUrl', ['careersSourceUrl', 'careersVerified']],
    ['contactEmail', ['contactEmailSourceUrl']],
  ]) {
    if (blank(url, inc[url])) continue;
    if (blank(url, cur[url])) {
      set(url, inc[url]);
      extras.forEach(fill);
    } else if (cur[url] === inc[url]) extras.forEach(fill);
  }
  if (inc.openRoles?.length) {
    const have = new Set((cur.openRoles || []).map((r) => r.title.toLowerCase()));
    const add = inc.openRoles.filter((r) => !have.has(r.title.toLowerCase()));
    if (add.length) set('openRoles', [...(cur.openRoles || []), ...add]);
  }
  const newKeys = Object.entries(inc.extra || {}).filter(([k]) => !(k in (cur.extra || {})));
  if (newKeys.length) set('extra', { ...(cur.extra || {}), ...Object.fromEntries(newKeys) });

  for (const f of changed) entry.changed.add(f);
  return changed;
}

// ---------- planning ----------

const DEFAULTS_ON_CREATE = { appStatus: 'Not Applied' };

/**
 * Pure planner: classify every row (create / update / skip / fail) without touching the database.
 * existing: lean Company docs. policy: 'skip' | 'update' (for confident duplicates).
 * decisions: { [row]: 'create' | 'skip' | 'update' } per-row overrides chosen in the UI.
 */
export function planImport({ existing, records, mapping, headers, policy = 'skip', decisions = {}, validate }) {
  const entries = [];
  const byDomain = new Map();
  const byName = new Map();
  const push = (map, k, e) => map.set(k, [...(map.get(k) || []), e]);
  const index = (e) => {
    const d = usableDomain(e.doc.domain);
    if (d) push(byDomain, d, e);
    push(byName, nameKey(e.doc.name), e);
  };
  for (const e of existing) {
    const entry = { id: e._id, doc: { ...e }, isNew: false, changed: new Set(), row: null };
    entries.push(entry);
    index(entry);
  }

  const plan = { created: 0, updated: 0, skipped: [], failed: [], warnings: [], duplicates: [], sample: [], toInsert: [] };
  const describe = (m) => (m.row ? `row ${m.row} of this file` : `existing record "${m.doc.name}"`);

  const findMatch = (doc) => {
    const nk = nameKey(doc.name);
    const d = usableDomain(doc.domain);
    if (d) {
      const m = byDomain.get(d)?.[0];
      if (m) {
        const same = nameKey(m.doc.name) === nk;
        return { entry: m, kind: 'domain', reason: `Same website domain (${d}) as ${describe(m)}${same ? '' : `, but with a different name ("${m.doc.name}")`}` };
      }
    }
    const sameNames = byName.get(nk) || [];
    for (const m of sameNames) {
      if (!usableDomain(m.doc.domain) || !d) {
        return { entry: m, kind: 'name', reason: `Same company name as ${describe(m)}; one of the two has no website to compare` };
      }
    }
    if (sameNames.length) {
      const m = sameNames[0];
      return { entry: m, kind: 'possible', reason: `Same name as ${describe(m)} but a different website (${m.doc.domain} vs ${doc.domain}). Treated as a different company unless you choose otherwise` };
    }
    return null;
  };

  for (const rec of records) {
    const { doc, warnings, error } = normalizeRow(rec, mapping, headers);
    for (const message of warnings) plan.warnings.push({ row: rec.row, message });
    if (error) {
      plan.failed.push({ row: rec.row, error, data: rec.values });
      continue;
    }

    const match = findMatch(doc);
    let action = 'create';
    if (match) {
      const fallback = match.kind === 'possible' ? 'create' : policy;
      const chosen = decisions[rec.row];
      action = ['create', 'skip', 'update'].includes(chosen) ? chosen : fallback;
      plan.duplicates.push({
        row: rec.row,
        name: doc.name,
        kind: match.kind,
        reason: match.reason,
        action,
        matchedName: match.entry.doc.name,
        matchedRow: match.entry.row,
      });
    }

    if (action === 'skip') {
      plan.skipped.push({ row: rec.row, name: doc.name, reason: match.reason });
    } else if (action === 'update') {
      const changed = mergeInto(match.entry, doc);
      if (changed.length) plan.updated++;
      else plan.skipped.push({ row: rec.row, name: doc.name, reason: 'Existing record already has this information' });
    } else {
      const full = { ...DEFAULTS_ON_CREATE, ...doc };
      const problem = validate?.(full);
      if (problem) {
        plan.failed.push({ row: rec.row, error: problem, data: rec.values });
        continue;
      }
      const entry = { id: null, doc: full, isNew: true, changed: new Set(), row: rec.row };
      entries.push(entry);
      index(entry);
      plan.created++;
    }
    if (plan.sample.length < 5) plan.sample.push({ row: rec.row, action, doc: sampleOf(doc) });
  }

  plan.toInsert = entries.filter((e) => e.isNew).map((e) => e.doc);
  plan.toUpdate = entries
    .filter((e) => !e.isNew && e.changed.size)
    .map((e) => ({ id: e.id, set: Object.fromEntries([...e.changed].map((f) => [f, e.doc[f]])) }));
  return plan;
}

function sampleOf(doc) {
  const { extra, ...rest } = doc;
  return { ...rest, extraKeys: Object.keys(extra || {}) };
}
