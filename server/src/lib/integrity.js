import CompanyModel from '../models/Company.js';
import ApplicationModel from '../models/Application.js';
import DraftModel from '../models/Draft.js';
import { rollup } from './applications.js';

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const sample = (ids) => ids.slice(0, 10).map(String);

/**
 * Check that companies, applications and drafts agree with each other.
 *  - orphan applications / drafts (their company no longer exists): REPORTED ONLY. Nothing is ever deleted here.
 *  - company summaries that don't match their applications: recomputed when repair=true (summaries are derived data).
 *  - drafts pointing at a missing application: the pointer is cleared when repair=true; the draft is kept.
 */
export async function checkIntegrity({
  Company = CompanyModel, Application = ApplicationModel, Draft = DraftModel, repair = false, apps,
} = {}) {
  const companies = await Company.find({}, 'appStatus appStatuses applicationCount appliedDate followUpDate lastContactDate').lean();
  const companyIds = new Set(companies.map((c) => String(c._id)));
  const allApps = await Application.find({}, 'company status appliedDate followUpDate lastContactDate').lean();
  const byCompany = new Map();
  for (const a of allApps) byCompany.set(String(a.company), [...(byCompany.get(String(a.company)) || []), a]);

  const orphanApplications = allApps.filter((a) => !companyIds.has(String(a.company))).map((a) => a._id);

  const mismatched = [];
  for (const c of companies) {
    const list = byCompany.get(String(c._id)) || [];
    // Older companies that carry tracking data but no applications are handled by the startup migration, not here.
    if (!list.length && !(c.applicationCount > 0)) continue;
    const want = rollup(list);
    const same =
      c.appStatus === want.appStatus &&
      (c.applicationCount || 0) === want.applicationCount &&
      [...(c.appStatuses || [])].sort().join('|') === [...want.appStatuses].sort().join('|') &&
      day(c.appliedDate) === day(want.appliedDate) &&
      day(c.followUpDate) === day(want.followUpDate) &&
      day(c.lastContactDate) === day(want.lastContactDate);
    if (!same) mismatched.push(c._id);
  }

  const appIds = new Set(allApps.map((a) => String(a._id)));
  const drafts = await Draft.find({}, 'company application').lean();
  const orphanDrafts = drafts.filter((d) => !companyIds.has(String(d.company))).map((d) => d._id);
  const danglingDrafts = drafts.filter((d) => d.application && !appIds.has(String(d.application))).map((d) => d._id);

  let repaired = 0;
  if (repair) {
    for (const id of mismatched) {
      if (apps) await apps.recompute(id);
      else await Company.updateOne({ _id: id }, { $set: rollup(byCompany.get(String(id)) || []) });
      repaired++;
    }
    if (danglingDrafts.length) {
      await Draft.updateMany({ _id: { $in: danglingDrafts } }, { $set: { application: null } });
      repaired += danglingDrafts.length;
    }
  }
  const issues = orphanApplications.length + orphanDrafts.length + mismatched.length + danglingDrafts.length;
  return {
    ok: issues === 0,
    counts: { companies: companies.length, applications: allApps.length, drafts: drafts.length },
    orphanApplications: { count: orphanApplications.length, sample: sample(orphanApplications) },
    orphanDrafts: { count: orphanDrafts.length, sample: sample(orphanDrafts) },
    summaryMismatches: { count: mismatched.length, sample: sample(mismatched) },
    draftsWithMissingApplication: { count: danglingDrafts.length, sample: sample(danglingDrafts) },
    repaired,
  };
}
