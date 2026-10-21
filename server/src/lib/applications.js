import { STATUSES, normalizeUrl } from './csv.js';
import { parseDate } from './importer.js';

export const TERMINAL = ['Rejected', 'Offer'];
export const HISTORY_CAP = 200;
// "Furthest along" ordering used to roll several applications up into one company-level status.
const RANK = { Rejected: 1, 'Not Applied': 2, 'To Apply': 3, Applied: 4, Replied: 5, Interview: 6, Offer: 7 };
const SENT_OR_LATER = ['Applied', 'Replied', 'Interview', 'Offer'];
const CONTACT_STATUSES = ['Replied', 'Interview', 'Offer', 'Rejected'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const DAY = 86_400_000;

export const startOfDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Normalised role used to spot duplicates: case, punctuation and spacing are ignored. */
export const roleKey = (role) =>
  String(role || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Normalised job URL: host, path and query without www, fragments, trailing slashes or tracking parameters. */
export function jobUrlKey(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|gh_src$|source$|src$)/i.test(k)) u.searchParams.delete(k);
    return `${u.host.replace(/^www\./i, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return '';
  }
}

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TEXT = { role: 200, contactName: 200, nextAction: 300, notes: 5000 };

/**
 * Validate and normalise application input. Returns only the keys that were supplied.
 * Everything must be the expected type, so objects (e.g. Mongo operators) never reach the database.
 */
export function cleanApplicationInput(body, { now = new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object.');
  const out = {};
  const str = (k) => {
    if (typeof body[k] !== 'string') throw bad(`${k} must be text.`);
    return body[k].trim();
  };

  for (const [k, max] of Object.entries(TEXT)) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'string') throw bad(`${k} must be text.`);
    const v = k === 'notes' ? body[k] : body[k].trim(); // notes keep their own spacing
    if (v.length > max) throw bad(`${k} is too long (${max} characters max).`);
    out[k] = v;
  }
  for (const k of ['jobUrl', 'contactUrl']) {
    if (!(k in body)) continue;
    const v = str(k);
    if (v.length > 2048) throw bad(`${k} is too long.`);
    if (v) {
      const n = normalizeUrl(v);
      if (!n) throw bad(`"${v.slice(0, 80)}" is not a valid web address (${k}).`);
      out[k] = n;
    } else out[k] = '';
  }
  if ('contactEmail' in body) {
    const v = str('contactEmail');
    if (v && (!EMAIL_OK.test(v) || v.length > 254)) throw bad('Contact email is not valid.');
    out.contactEmail = v;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) throw bad(`Invalid status. Use one of: ${STATUSES.join(', ')}`);
    out.status = body.status;
  }
  const latest = new Date(startOfDay(now).getTime() + 1 * DAY); // tolerate time zones ahead of UTC
  for (const k of ['appliedDate', 'lastContactDate', 'followUpDate']) {
    if (!(k in body)) continue;
    const raw = body[k];
    if (raw === null || raw === '') {
      out[k] = null;
      continue;
    }
    if (typeof raw !== 'string') throw bad(`${k} must be a date like 2026-10-31.`);
    const d = parseDate(raw.trim());
    if (!d) throw bad(`${k} must be a real date like 2026-10-31.`);
    const day = startOfDay(d);
    if (k !== 'followUpDate' && day > latest) throw bad(`${k} can't be in the future.`);
    out[k] = day;
  }
  return out;
}

/**
 * Decide what an update changes. Returns { set, history } where set holds only changed fields.
 * Side effects: moving to Applied or later fills a missing applied date; replies, interviews, offers
 * and rejections fill a missing last-contact date. Nothing is ever cleared implicitly.
 */
export function planUpdate(current, patch, now = new Date()) {
  const today = startOfDay(now);
  const next = { ...patch };
  const history = [];
  let autoContact = false; // an auto-filled contact date is implied by the status entry, so it is not logged separately
  const same = (a, b) => (a instanceof Date || b instanceof Date || typeof a === 'object' || typeof b === 'object' ? fmt(a) === fmt(b) : (a ?? '') === (b ?? ''));

  if ('status' in next && next.status !== current.status) {
    history.push({ type: 'status', from: current.status, to: next.status, summary: `Status: ${current.status} → ${next.status}` });
    if (SENT_OR_LATER.includes(next.status) && !current.appliedDate && !('appliedDate' in next)) {
      next.appliedDate = today;
      history.push({ type: 'applied', summary: `Application submitted (recorded as ${fmt(today)})`, to: fmt(today) });
    }
    if (CONTACT_STATUSES.includes(next.status) && !current.lastContactDate && !('lastContactDate' in next)) {
      next.lastContactDate = today;
      autoContact = true;
    }
  }
  if ('appliedDate' in next && !same(next.appliedDate, current.appliedDate) && !history.some((h) => h.type === 'applied')) {
    history.push({
      type: 'applied',
      from: fmt(current.appliedDate),
      to: fmt(next.appliedDate),
      summary: next.appliedDate ? (current.appliedDate ? `Applied date changed ${fmt(current.appliedDate)} → ${fmt(next.appliedDate)}` : `Applied date set to ${fmt(next.appliedDate)}`) : 'Applied date cleared',
    });
  }
  if ('followUpDate' in next && !same(next.followUpDate, current.followUpDate)) {
    history.push({
      type: 'followUp',
      from: fmt(current.followUpDate),
      to: fmt(next.followUpDate),
      summary: !next.followUpDate ? 'Follow-up cleared' : current.followUpDate ? `Follow-up moved ${fmt(current.followUpDate)} → ${fmt(next.followUpDate)}` : `Follow-up set for ${fmt(next.followUpDate)}`,
    });
  }
  if ('lastContactDate' in next && !autoContact && !same(next.lastContactDate, current.lastContactDate)) {
    history.push({
      type: 'contact',
      from: fmt(current.lastContactDate),
      to: fmt(next.lastContactDate),
      summary: next.lastContactDate ? `Last contact recorded: ${fmt(next.lastContactDate)}` : 'Last contact cleared',
    });
  }
  for (const [k, label] of [['role', 'Role'], ['jobUrl', 'Job posting URL']]) {
    if (k in next && !same(next[k], current[k])) {
      history.push({ type: 'details', summary: `${label} ${current[k] ? `changed from "${current[k]}" to "${next[k] || '(empty)'}"` : `set to "${next[k]}"`}`.slice(0, 590) });
    }
  }

  const set = {};
  for (const [k, v] of Object.entries(next)) if (!same(v, current[k])) set[k] = v;
  if ('role' in set) set.roleKey = roleKey(set.role);
  if ('jobUrl' in set) set.jobUrlKey = set.jobUrl ? jobUrlKey(set.jobUrl) : '';

  const appliedDate = 'appliedDate' in set ? set.appliedDate : current.appliedDate;
  const followUpDate = 'followUpDate' in set ? set.followUpDate : current.followUpDate;
  if (appliedDate && followUpDate && startOfDay(followUpDate) < startOfDay(appliedDate)) {
    throw bad("The follow-up date can't be before the applied date.");
  }
  return { set, history };
}

export const isTerminal = (status) => TERMINAL.includes(status);

/** Overdue = a follow-up date before today on an application that is still open. */
export function isOverdue(app, now = new Date()) {
  return !!app.followUpDate && !isTerminal(app.status) && startOfDay(app.followUpDate) < startOfDay(now);
}
/** Due = a follow-up date of today or earlier on an application that is still open. */
export function isDue(app, now = new Date()) {
  return !!app.followUpDate && !isTerminal(app.status) && startOfDay(app.followUpDate) <= startOfDay(now);
}

/**
 * Company-level summary of its applications (kept on the company for filtering and the legacy fields):
 * furthest-along status, every status present, earliest applied date, earliest open follow-up, latest contact.
 */
export function rollup(apps) {
  if (!apps.length) {
    return { appStatus: 'Not Applied', appStatuses: [], applicationCount: 0, appliedDate: null, followUpDate: null, lastContactDate: null };
  }
  const appStatus = apps.reduce((best, a) => (RANK[a.status] > RANK[best] ? a.status : best), apps[0].status);
  const times = (arr, key) => arr.map((a) => a[key]).filter(Boolean).map((d) => new Date(d).getTime());
  const min = (t) => (t.length ? new Date(Math.min(...t)) : null);
  const max = (t) => (t.length ? new Date(Math.max(...t)) : null);
  return {
    appStatus,
    appStatuses: [...new Set(apps.map((a) => a.status))],
    applicationCount: apps.length,
    appliedDate: min(times(apps, 'appliedDate')),
    followUpDate: min(times(apps.filter((a) => !isTerminal(a.status)), 'followUpDate')),
    lastContactDate: max(times(apps, 'lastContactDate')),
  };
}

export const appendHistory = (history, entries, now = new Date()) =>
  [...history, ...entries.map((e) => ({ at: now, ...e }))].slice(-HISTORY_CAP);

/**
 * Defaults for a new application. `autofill` (user-created applications) records today as the applied date when
 * the status is Applied or later. Migrated/imported data passes autofill=false: a date is never invented.
 */
export function planCreate(patch, { now = new Date(), autofill = true } = {}) {
  const data = { role: '', jobUrl: '', status: 'To Apply', ...patch };
  const today = startOfDay(now);
  if (autofill) {
    if (SENT_OR_LATER.includes(data.status) && !('appliedDate' in patch)) data.appliedDate = today;
    if (CONTACT_STATUSES.includes(data.status) && !('lastContactDate' in patch)) data.lastContactDate = today;
  }
  if (data.appliedDate && data.followUpDate && startOfDay(data.followUpDate) < startOfDay(data.appliedDate)) {
    throw bad("The follow-up date can't be before the applied date.");
  }
  data.roleKey = roleKey(data.role);
  data.jobUrlKey = data.jobUrl ? jobUrlKey(data.jobUrl) : '';
  return data;
}
