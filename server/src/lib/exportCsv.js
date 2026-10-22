import { stringify } from 'csv-stringify/sync';

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const yesNo = (b) => (b ? 'yes' : 'no');
// ")" inside a URL would break the "title (url)" round trip.
const roleText = (r) => (r.url ? `${r.title} (${r.url.replace(/\)/g, '%29')})` : r.title);

/** [header, getter]. Every header is an alias understood by the importer, so exports re-import cleanly. */
export const EXPORT_COLUMNS = [
  ['Company', (c) => c.name],
  ['Website', (c) => c.website],
  ['Location', (c) => c.location],
  ['Industry', (c) => c.industry],
  ['Funding Status', (c) => c.fundingStatus],
  ['Funding Stage', (c) => c.fundingStage],
  ['Funding Amount', (c) => c.fundingAmount],
  ['Funding Date', (c) => c.fundingDate],
  ['Funding Source URL', (c) => c.fundingSourceUrl],
  ['Funding Verified', (c) => yesNo(c.fundingVerified)],
  ['Careers URL', (c) => c.careersUrl],
  ['Careers Source URL', (c) => c.careersSourceUrl],
  ['Careers Verified', (c) => yesNo(c.careersVerified)],
  ['Contact Email', (c) => c.contactEmail],
  ['Contact Email Source URL', (c) => c.contactEmailSourceUrl],
  ['Contact Name', (c) => c.contactName],
  ['Relevant Roles', (c) => c.hasRelevantRoles],
  ['Open Roles', (c) => (c.openRoles || []).map(roleText).join(' | ')],
  ['Research Status', (c) => (c.researchStatus === 'running' ? 'not_researched' : c.researchStatus)],
  ['Researched At', (c) => (c.researchedAt ? new Date(c.researchedAt).toISOString() : '')],
  ['Application Status', (c) => c.appStatus],
  ['Applied Date', (c) => day(c.appliedDate)],
  ['Follow-up Date', (c) => day(c.followUpDate)],
  ['Notes', (c) => c.notes],
];

const STANDARD = new Set(EXPORT_COLUMNS.map(([h]) => h.toLowerCase()));

/**
 * Cells that a spreadsheet would treat as formulas get a leading apostrophe on export only.
 * The stored value is untouched, and the importer removes the apostrophe again.
 */
export const guardCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function buildCsv(items) {
  // Unmapped import columns live in `extra`; export them as extra columns so a re-import keeps them.
  const extraKeys = [...new Set(items.flatMap((c) => Object.keys(c.extra || {})))].sort();
  const extraHeader = (k) => (STANDARD.has(k.toLowerCase()) ? `${k} (extra)` : k);
  const headers = [...EXPORT_COLUMNS.map(([h]) => h), ...extraKeys.map(extraHeader)];
  const rows = items.map((c) => [
    ...EXPORT_COLUMNS.map(([, get]) => guardCell(get(c) ?? '')),
    ...extraKeys.map((k) => guardCell(c.extra?.[k] == null ? '' : String(c.extra[k]))),
  ]);
  return '﻿' + stringify([headers.map(guardCell), ...rows]);
}
