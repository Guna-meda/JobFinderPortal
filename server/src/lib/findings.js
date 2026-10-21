import { normalizeUrl, domainOf, FUNDING_STAGES } from './csv.js';

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const findingKey = (f) => {
  const v = String(f.kind === 'role' ? f.value || f.title : f.value).trim().toLowerCase();
  return `${f.kind}|${v}`;
};

/**
 * Reconcile the findings of a finished run with those already stored.
 *  - A re-observed finding keeps its review decision (an accepted/rejected finding is never re-proposed as new)
 *    and gets a fresh observedAt.
 *  - New findings are added as pending.
 *  - Findings not seen this time are flagged seenInLatestRun=false ("not re-observed"), never deleted.
 *    (markUnseen=false for failed/partial runs, which did not read every page.)
 * `existing` are plain objects; returns a new array.
 */
export function mergeFindings(existing, candidates, { max = 100, markUnseen = true } = {}) {
  const byKey = new Map();
  const out = existing.map((f) => ({ ...f, seenInLatestRun: markUnseen ? false : f.seenInLatestRun }));
  out.forEach((f) => byKey.set(findingKey(f), f));
  for (const c of candidates) {
    const hit = byKey.get(findingKey(c));
    if (hit) {
      hit.seenInLatestRun = true;
      hit.observedAt = c.observedAt;
      if (hit.status === 'pending') Object.assign(hit, { sourceUrl: c.sourceUrl, evidence: c.evidence, confidence: c.confidence, meta: c.meta });
    } else {
      const f = { ...c, status: 'pending', seenInLatestRun: true };
      out.push(f);
      byKey.set(findingKey(f), f);
    }
  }
  if (out.length > max) {
    // Drop the oldest undecided findings first; never drop accepted/rejected decisions unless unavoidable.
    const rank = (f) => (f.status === 'pending' ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || new Date(a.observedAt) - new Date(b.observedAt));
    out.splice(0, out.length - max);
  }
  return out;
}

class Conflict extends Error {
  constructor(field, current) {
    super(`This would replace the current ${field}.`);
    this.conflict = { field, current };
  }
}
const bad = (m) => Object.assign(new Error(m), { status: 400 });

/**
 * Compute the company changes for accepting a finding. Never silently replaces an existing different value:
 * throws Conflict unless `overwrite` is true. Edited values lose the research source and verified flag.
 * Returns a plain `set` object for the company.
 */
export function applyFinding(company, finding, { value, overwrite = false } = {}) {
  const set = {};
  const clash = (field, cur, next) => {
    if (cur && cur !== next && !overwrite) throw new Conflict(field, cur);
  };
  switch (finding.kind) {
    case 'careers': {
      const v = normalizeUrl(value ?? finding.value);
      if (!v) throw bad('That is not a valid URL.');
      clash('careers URL', company.careersUrl, v);
      const edited = v !== normalizeUrl(finding.value);
      Object.assign(set, { careersUrl: v, careersSourceUrl: edited ? '' : finding.sourceUrl, careersVerified: !edited && finding.confidence === 'verified' });
      break;
    }
    case 'email': {
      const v = String(value ?? finding.value).trim().toLowerCase();
      if (!EMAIL_OK.test(v)) throw bad('That is not a valid email address.');
      clash('contact email', company.contactEmail, v);
      const edited = v !== String(finding.value).toLowerCase();
      Object.assign(set, { contactEmail: v, contactEmailSourceUrl: edited ? '' : finding.sourceUrl });
      break;
    }
    case 'website': {
      const v = normalizeUrl(value ?? finding.value);
      if (!v) throw bad('That is not a valid URL.');
      clash('website', company.website, v);
      Object.assign(set, { website: v, domain: domainOf(v) });
      break;
    }
    case 'role': {
      const title = String(value ?? finding.title ?? '').trim().slice(0, 200);
      if (!title) throw bad('A role needs a title.');
      const roles = company.openRoles || [];
      if (!roles.some((r) => (r.url && r.url === finding.value) || r.title.toLowerCase() === title.toLowerCase())) {
        set.openRoles = [...roles.map((r) => ({ title: r.title, url: r.url, sourceUrl: r.sourceUrl, observedAt: r.observedAt })),
          { title, url: finding.value, sourceUrl: finding.sourceUrl, observedAt: finding.observedAt }];
      }
      if (!company.hasRelevantRoles || company.hasRelevantRoles === 'unknown') set.hasRelevantRoles = 'yes';
      break;
    }
    case 'funding': {
      const m = finding.meta || {};
      const next = { fundingStatus: 'funded' };
      if (m.stage && FUNDING_STAGES.includes(m.stage)) next.fundingStage = m.stage;
      if (m.amount) next.fundingAmount = m.amount;
      if (m.date) next.fundingDate = m.date;
      const protectedVerified = company.fundingVerified;
      const differs =
        (company.fundingStatus && company.fundingStatus !== 'unknown' && company.fundingStatus !== next.fundingStatus) ||
        (next.fundingStage && company.fundingStage && company.fundingStage !== 'unknown' && company.fundingStage !== next.fundingStage) ||
        (next.fundingAmount && company.fundingAmount && company.fundingAmount !== next.fundingAmount) ||
        (next.fundingDate && company.fundingDate && company.fundingDate !== next.fundingDate);
      if ((protectedVerified || differs) && !overwrite) throw new Conflict('funding details', protectedVerified ? 'verified funding data' : 'existing funding data');
      // The company's own claim is recorded with its source but is NOT marked verified.
      Object.assign(set, next, { fundingSourceUrl: finding.sourceUrl, fundingVerified: false });
      break;
    }
    default:
      throw bad('Unknown finding type.');
  }
  return set;
}

export { Conflict };
