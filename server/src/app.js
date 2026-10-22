import express from 'express';
import cors from 'cors';
import multer from 'multer';
import mongoose from 'mongoose';
import Company from './models/Company.js';
import { buildFilter, sortFor } from './lib/filters.js';
import {
  normalizeUrl,
  domainOf,
  STATUSES,
  FUNDING_STATUSES,
  FUNDING_STAGES,
} from './lib/csv.js';
import Application from './models/Application.js';
import { createResearchService } from './lib/researchService.js';
import { createApplicationService } from './lib/applicationService.js';
import { TERMINAL } from './lib/applications.js';
import { registerApplications } from './routes/applications.js';
import { createOutreachService } from './lib/outreachService.js';
import { registerOutreach } from './routes/outreach.js';
import { registerImportExport } from './routes/importExport.js';
import { registerResearch } from './routes/research.js';
import {
  securityFromEnv, securityHeaders, hostGuard, originGuard, buildLimiters, errorHandler,
} from './middleware/security.js';

// One CSV file only: no extra files, a handful of small form fields (mapping, policy, decisions, dryRun).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 8, parts: 10, fieldSize: 1024 * 1024 },
});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (id) => mongoose.isValidObjectId(id);

const EDITABLE = [
  'name', 'website', 'location', 'industry', 'fundingStatus', 'fundingStage', 'fundingAmount', 'fundingDate', 'fundingSourceUrl', 'fundingVerified',
  'careersUrl', 'contactEmail', 'contactName', 'hasRelevantRoles', 'appStatus', 'appliedDate', 'followUpDate', 'notes',
];
const URL_FIELDS = ['website', 'careersUrl', 'fundingSourceUrl'];
const DATE_FIELDS = ['appliedDate', 'followUpDate'];

const TEXT_LIMITS = {
  name: 200, website: 2048, location: 200, industry: 200, fundingSourceUrl: 2048, careersUrl: 2048,
  contactName: 200, contactEmail: 254, notes: 10000, fundingAmount: 100, fundingDate: 100,
};
const ENUMS = {
  appStatus: [STATUSES, 'Invalid status. Use one of: ' + STATUSES.join(', ')],
  fundingStatus: [FUNDING_STATUSES, 'Invalid funding status.'],
  fundingStage: [FUNDING_STAGES, 'Invalid funding stage.'],
  hasRelevantRoles: [['unknown', 'yes', 'no'], 'Invalid value for relevant roles.'],
};

/** Validate a company edit: whitelisted keys only, the right types, sane lengths, valid URLs/emails/dates. */
export function cleanPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object.');
  const patch = {};
  for (const k of EDITABLE) if (k in body) patch[k] = body[k];
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (!(k in patch)) continue;
    if (typeof patch[k] !== 'string') throw bad(`${k} must be text.`);
    if (k !== 'notes') patch[k] = patch[k].trim();
    if (patch[k].length > max) throw bad(`${k} is too long (${max} characters max).`);
  }
  if ('name' in patch && !patch.name) throw bad('Company name is required.');
  for (const [k, [allowed, message]] of Object.entries(ENUMS)) {
    if (k in patch && !allowed.includes(patch[k])) throw bad(message);
  }
  if ('fundingVerified' in patch && typeof patch.fundingVerified !== 'boolean') throw bad('fundingVerified must be true or false.');
  for (const k of URL_FIELDS) {
    if (k in patch && patch[k]) {
      const u = normalizeUrl(patch[k]);
      if (!u) throw bad(`That is not a valid web address (${k}).`);
      patch[k] = u;
    }
  }
  if (patch.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.contactEmail)) throw bad('Contact email is not valid.');
  for (const k of DATE_FIELDS) {
    if (!(k in patch)) continue;
    if (patch[k] === null || patch[k] === '') patch[k] = null;
    else if (typeof patch[k] !== 'string' || Number.isNaN(new Date(patch[k]).getTime())) throw bad(`${k} is not a valid date.`);
  }
  if (patch.website !== undefined) patch.domain = domainOf(patch.website);
  return patch;
}

export function createApp({
  research = createResearchService(),
  applications: apps = createApplicationService(),
  outreach = createOutreachService({ apps }),
  security = securityFromEnv(),
  limits = {},
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Local tool: only this machine's own names may reach it, and only our own pages may call it from a browser.
  app.use(hostGuard(security.allowedHosts));
  app.use(originGuard(security.allowedOrigins));
  app.use(cors({ origin: security.allowedOrigins, credentials: false }));
  const limit = buildLimiters(limits);
  app.use('/api', limit.general);
  // Expensive operations get their own, tighter limits (registered before the routes they protect).
  app.post('/api/companies/:id/research', limit.research);
  app.post('/api/research/batch', limit.batch);
  app.post(['/api/import', '/api/import/preview'], limit.import);
  app.post('/api/outreach/generate', limit.outreach);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));

  app.get('/api/companies', wrap(async (req, res) => {
    const filter = buildFilter(req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [items, total] = await Promise.all([
      Company.find(filter).sort(sortFor(req.query.sort)).skip((page - 1) * limit).limit(limit).lean(),
      Company.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  }));

  app.get('/api/facets', wrap(async (req, res) => {
    const [locations, industries] = await Promise.all([Company.distinct('location'), Company.distinct('industry')]);
    const clean = (a) => a.filter(Boolean).sort((x, y) => x.localeCompare(y));
    res.json({ locations: clean(locations), industries: clean(industries) });
  }));

  app.get('/api/stats', wrap(async (req, res) => {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [total, researched, byStatus, followUpsDue, followUpsOverdue, withRoles] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ researchStatus: { $in: ['researched', 'partial', 'not_found'] } }),
      Application.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Application.countDocuments({ followUpDate: { $lte: now }, status: { $nin: TERMINAL } }),
      Application.countDocuments({ followUpDate: { $lt: todayStart }, status: { $nin: TERMINAL } }),
      Company.countDocuments({ hasRelevantRoles: 'yes' }),
    ]);
    const s = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const r of byStatus) s[r._id] = r.n;
    res.json({
      total,
      researched,
      applied: s.Applied + s.Replied + s.Interview + s.Rejected + s.Offer,
      replies: s.Replied + s.Interview + s.Offer,
      interviews: s.Interview,
      offers: s.Offer,
      followUpsDue,
      followUpsOverdue,
      withRoles,
      byStatus: s,
    });
  }));

  registerImportExport(app, { upload, wrap, apps });

  app.post('/api/companies', wrap(async (req, res) => {
    const patch = cleanPatch(req.body);
    if (!patch.name) throw bad('Company name is required.');
    const created = await Company.create(patch);
    await apps.syncLegacy([created._id]); // tracking fields in the request become an application
    res.status(201).json(await Company.findById(created._id).lean());
  }));

  app.get('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const c = await Company.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    res.json(c);
  }));

  app.patch('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const patch = cleanPatch(req.body);
    const current = await Company.findById(req.params.id, 'careersUrl contactEmail').lean();
    if (!current) return res.status(404).json({ error: 'Company not found.' });
    // Status and dates now live on applications; the company-level fields are a summary kept by the server.
    const tracking = {};
    for (const k of ['appStatus', 'appliedDate', 'followUpDate']) if (k in patch) { tracking[k] = patch[k]; delete patch[k]; }
    await apps.legacyApply(req.params.id, tracking);
    // A hand-edited value no longer comes from the recorded research source, so drop that provenance.
    if ('careersUrl' in patch && (patch.careersUrl || '') !== (current.careersUrl || '')) Object.assign(patch, { careersSourceUrl: '', careersVerified: false });
    if ('contactEmail' in patch && (patch.contactEmail || '') !== (current.contactEmail || '')) patch.contactEmailSourceUrl = '';
    const c = await Company.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true, runValidators: true }).lean();
    res.json(c);
  }));

  app.delete('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    await Company.findByIdAndDelete(req.params.id);
    await apps.removeForCompany(req.params.id); // never leave orphaned applications behind
    await outreach.removeForCompany(req.params.id);
    res.status(204).end();
  }));

  registerResearch(app, { wrap, service: research });
  registerApplications(app, { wrap, apps });
  registerOutreach(app, { wrap, outreach });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}
