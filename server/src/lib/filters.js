const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const one = (v) => (Array.isArray(v) ? v[0] : v);

/** Build a Mongo filter from query-string params. All filters are ANDed. */
export function buildFilter(q = {}) {
  const f = {};
  const text = one(q.q) && String(one(q.q)).trim().slice(0, 200);
  if (text) {
    const rx = new RegExp(esc(text), 'i');
    f.$or = [{ name: rx }, { domain: rx }, { industry: rx }, { location: rx }, { notes: rx }, { contactName: rx }];
  }
  for (const k of ['fundingStatus', 'fundingStage', 'researchStatus', 'hasRelevantRoles']) {
    if (one(q[k])) f[k] = String(one(q[k]));
  }
  // A company matches a status if ANY of its applications has it. Companies not yet converted to application
  // records (older data) are matched on their own status field.
  if (one(q.appStatus)) {
    const s = String(one(q.appStatus));
    const and = f.$and || [];
    and.push({ $or: [{ appStatuses: s }, { applicationCount: { $not: { $gt: 0 } }, appStatus: s }] });
    f.$and = and;
  }
  if (one(q.location)) f.location = new RegExp(esc(one(q.location)), 'i');
  if (one(q.industry)) f.industry = new RegExp(esc(one(q.industry)), 'i');
  if (one(q.followUpDue) === 'true') f.followUpDate = { $lte: new Date() };
  return f;
}

const SORTS = {
  name: { name: 1 },
  recent: { updatedAt: -1 },
  followUp: { followUpDate: 1, name: 1 },
  status: { appStatus: 1, name: 1 },
};
// Own keys only: a query like ?sort=constructor must not reach Object.prototype.
export const sortFor = (s) => (typeof one(s) === 'string' && Object.hasOwn(SORTS, one(s)) ? SORTS[one(s)] : SORTS.name);
