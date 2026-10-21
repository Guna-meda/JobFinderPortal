const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const one = (v) => (Array.isArray(v) ? v[0] : v);

/** Build a Mongo filter from query-string params. All filters are ANDed. */
export function buildFilter(q = {}) {
  const f = {};
  const text = one(q.q) && String(one(q.q)).trim();
  if (text) {
    const rx = new RegExp(esc(text), 'i');
    f.$or = [{ name: rx }, { domain: rx }, { industry: rx }, { location: rx }, { notes: rx }, { contactName: rx }];
  }
  for (const k of ['fundingStatus', 'fundingStage', 'appStatus', 'researchStatus', 'hasRelevantRoles']) {
    if (one(q[k])) f[k] = String(one(q[k]));
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
export const sortFor = (s) => SORTS[one(s)] || SORTS.name;
