import CompanyModel from '../models/Company.js';
import ApplicationModel from '../models/Application.js';
import {
  cleanApplicationInput, planUpdate, planCreate, rollup, roleKey, jobUrlKey, appendHistory,
} from './applications.js';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const duplicate = (existing, why) =>
  fail(409, `You already track ${why}${existing.role ? ` ("${existing.role}")` : ' (a general application)'} at this company. Edit that one, or give this role a different title.`, {
    code: 'duplicate_application',
    existing: { _id: String(existing._id), role: existing.role },
  });

/**
 * Application records are the source of truth for tracking. The company keeps a server-maintained summary
 * (status, dates, count) so lists, filters and the older company-level fields keep working.
 */
export function createApplicationService({ Company = CompanyModel, Application = ApplicationModel } = {}) {
  async function recompute(companyId) {
    const apps = await Application.find({ company: companyId }).lean();
    await Company.updateOne({ _id: companyId }, { $set: rollup(apps) });
    return apps.length;
  }

  async function findDuplicate(companyId, role, url, excludeId) {
    const or = [{ roleKey: roleKey(role) }];
    if (url) or.push({ jobUrlKey: jobUrlKey(url) });
    const q = { company: companyId, $or: or };
    if (excludeId) q._id = { $ne: excludeId };
    return Application.findOne(q).lean();
  }

  const whyDuplicate = (existing, role, url) =>
    url && existing.jobUrlKey && existing.jobUrlKey === jobUrlKey(url) && existing.roleKey !== roleKey(role) ? 'this job posting' : roleKey(role) ? 'this role' : 'a general application';

  async function create(companyId, input, { autofill = true, summary, type = 'created', defaults = {} } = {}) {
    if (!(await Company.exists({ _id: companyId }))) throw fail(404, 'Company not found.');
    const now = new Date();
    const patch = { ...defaults, ...cleanApplicationInput(input, { now }) };
    const data = planCreate(patch, { now, autofill });
    const existing = await findDuplicate(companyId, data.role, data.jobUrl);
    if (existing) throw duplicate(existing, whyDuplicate(existing, data.role, data.jobUrl));
    let doc;
    try {
      doc = await Application.create({
        company: companyId,
        ...data,
        history: [{ at: now, type, to: data.status, summary: summary || `Application added as "${data.status}"` }],
      });
    } catch (e) {
      if (e.code === 11000) {
        const again = await findDuplicate(companyId, data.role, data.jobUrl);
        throw duplicate(again || { role: data.role, _id: '' }, 'this role');
      }
      throw e;
    }
    await recompute(companyId);
    return doc.toObject();
  }

  async function update(id, input) {
    const app = await Application.findById(id);
    if (!app) throw fail(404, 'Application not found.');
    const now = new Date();
    const patch = cleanApplicationInput(input, { now });
    const current = app.toObject();
    const { set, history } = planUpdate(current, patch, now);
    if (!Object.keys(set).length) return current;
    if ('roleKey' in set || 'jobUrlKey' in set) {
      const role = 'role' in set ? set.role : current.role;
      const url = 'jobUrl' in set ? set.jobUrl : current.jobUrl;
      const existing = await findDuplicate(current.company, role, url, app._id);
      if (existing) throw duplicate(existing, whyDuplicate(existing, role, url));
    }
    app.set(set);
    app.set('history', appendHistory(current.history || [], history, now));
    try {
      await app.save();
    } catch (e) {
      if (e.code === 11000) throw duplicate({ role: set.role ?? current.role, _id: '' }, 'this role');
      throw e;
    }
    await recompute(current.company);
    return app.toObject();
  }

  async function remove(id) {
    const app = await Application.findByIdAndDelete(id).lean();
    if (!app) return null;
    await recompute(app.company);
    return app;
  }

  async function addNote(id, text) {
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'Write something to record.');
    if (text.trim().length > 500) throw fail(400, 'Activity notes are limited to 500 characters.');
    const app = await Application.findById(id);
    if (!app) throw fail(404, 'Application not found.');
    app.set('history', appendHistory(app.toObject().history || [], [{ type: 'note', summary: text.trim() }]));
    await app.save();
    return app.toObject();
  }

  // A typed entry in the history (e.g. an outreach email you marked as sent).
  async function logActivity(id, type, summary) {
    const app = await Application.findById(id);
    if (!app) return null;
    app.set('history', appendHistory(app.toObject().history || [], [{ type, summary: String(summary).slice(0, 590) }]));
    await app.save();
    return app.toObject();
  }

  /**
   * Compatibility for the older company-level fields (appStatus, appliedDate, followUpDate): they now act on the
   * company's single application, create one if there is none, and refuse when there are several.
   */
  async function legacyApply(companyId, fields) {
    const input = {};
    if ('appStatus' in fields) input.status = fields.appStatus;
    if ('appliedDate' in fields) input.appliedDate = fields.appliedDate;
    if ('followUpDate' in fields) input.followUpDate = fields.followUpDate;
    if (!Object.keys(input).length) return;
    const apps = await Application.find({ company: companyId }, '_id').lean();
    if (apps.length > 1) {
      throw fail(409, 'This company has several applications. Change status and dates on the individual application.', { code: 'multiple_applications' });
    }
    if (apps.length === 1) {
      await update(apps[0]._id, input);
      return;
    }
    const meaningful = (input.status && input.status !== 'Not Applied') || input.appliedDate || input.followUpDate;
    if (meaningful) await create(companyId, input, { defaults: { status: 'Not Applied' } });
  }

  /**
   * For companies that carry tracking data but no application records (imports, older data): create one general
   * application from those company fields, without inventing dates, then refresh the company summary.
   */
  async function syncLegacy(companyIds, { type = 'created', summary } = {}) {
    let created = 0;
    for (const id of companyIds) {
      const c = await Company.findById(id).lean();
      if (!c) continue;
      const count = await Application.countDocuments({ company: id });
      const tracked = (c.appStatus && c.appStatus !== 'Not Applied') || c.appliedDate || c.followUpDate;
      if (!count && tracked) {
        const input = { status: c.appStatus || 'Not Applied' };
        if (c.appliedDate) input.appliedDate = new Date(c.appliedDate).toISOString().slice(0, 10);
        if (c.followUpDate) input.followUpDate = new Date(c.followUpDate).toISOString().slice(0, 10);
        if (c.contactName) input.contactName = c.contactName.slice(0, 200);
        if (c.contactEmail) input.contactEmail = c.contactEmail;
        try {
          await create(id, input, { autofill: false, type, summary: summary || 'Created from the company-level tracking columns' });
          created++;
          continue;
        } catch (e) {
          if (e.code === 'duplicate_application') continue; // a concurrent run already created it
          // Old data may not satisfy today's stricter validation; keep it as it is rather than lose or alter it.
          if (e.status === 400) {
            console.warn(`Could not convert tracking data for company ${id}: ${e.message}`);
            continue;
          }
          throw e;
        }
      }
      await recompute(id);
    }
    return created;
  }

  /** One-time, idempotent, non-destructive conversion of company-level tracking into application records. */
  async function migrateAll() {
    const ids = await Company.find(
      {
        applicationCount: { $not: { $gt: 0 } },
        $or: [{ appStatus: { $ne: 'Not Applied' } }, { appliedDate: { $ne: null } }, { followUpDate: { $ne: null } }],
      },
      '_id'
    ).lean();
    const created = await syncLegacy(ids.map((c) => c._id), { type: 'migrated', summary: 'Created from earlier company-level tracking (migration)' });
    return { candidates: ids.length, created };
  }

  return {
    recompute, create, update, remove, addNote, logActivity, legacyApply, syncLegacy, migrateAll,
    list: (companyId) => Application.find({ company: companyId }).sort({ createdAt: -1 }).lean(),
    removeForCompany: (companyId) => Application.deleteMany({ company: companyId }),
  };
}
