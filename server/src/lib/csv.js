export const STATUSES = ['Not Applied', 'To Apply', 'Applied', 'Replied', 'Interview', 'Rejected', 'Offer'];
export const FUNDING_STATUSES = ['unknown', 'bootstrapped', 'funded'];
export const FUNDING_STAGES = ['unknown', 'pre-seed', 'seed', 'series-a', 'series-b', 'series-c+', 'other'];

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
