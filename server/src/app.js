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
import { registerImportExport } from './routes/importExport.js';
import { registerResearch } from './routes/research.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (id) => mongoose.isValidObjectId(id);

const EDITABLE = [
  'name', 'website', 'location', 'industry', 'fundingStatus', 'fundingStage', 'fundingAmount', 'fundingDate', 'fundingSourceUrl', 'fundingVerified',
  'careersUrl', 'contactEmail', 'contactName', 'hasRelevantRoles', 'appStatus', 'appliedDate', 'followUpDate', 'notes',
];
const URL_FIELDS = ['website', 'careersUrl', 'fundingSourceUrl'];
const DATE_FIELDS = ['appliedDate', 'followUpDate'];

export function cleanPatch(body = {}) {
  const patch = {};
  for (const k of EDITABLE) if (k in body) patch[k] = body[k];
  if ('name' in patch && !String(patch.name).trim()) throw bad('Company name is required.');
  if (patch.appStatus && !STATUSES.includes(patch.appStatus)) throw bad(`Invalid status. Use one of: ${STATUSES.join(', ')}`);
  if (patch.fundingStatus && !FUNDING_STATUSES.includes(patch.fundingStatus)) throw bad('Invalid funding status.');
  if (patch.fundingStage && !FUNDING_STAGES.includes(patch.fundingStage)) throw bad('Invalid funding stage.');
  for (const k of URL_FIELDS) {
    if (k in patch && patch[k]) {
      const u = normalizeUrl(patch[k]);
      if (!u) throw bad(`"${patch[k]}" is not a valid URL (${k}).`);
      patch[k] = u;
    }
  }
  for (const k of ['fundingAmount', 'fundingDate']) {
    if (k in patch) {
      patch[k] = String(patch[k] ?? '').trim();
      if (patch[k].length > 100) throw bad(`${k} is too long (100 characters max).`);
    }
  }
  if (patch.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.contactEmail)) throw bad('Contact email is not valid.');
  for (const k of DATE_FIELDS) {
    if (k in patch) {
      if (!patch[k]) patch[k] = null;
      else if (Number.isNaN(new Date(patch[k]).getTime())) throw bad(`${k} is not a valid date.`);
    }
  }
  if (patch.website !== undefined) patch.domain = domainOf(patch.website);
  return patch;
}

export function createApp({ research = createResearchService(), applications: apps = createApplicationService() } = {}) {
  const app = express();
  app.use(cors());
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
    res.status(204).end();
  }));

  registerResearch(app, { wrap, service: research });
  registerApplications(app, { wrap, apps });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (10 MB max).' });
    const status = err.status || (err.name === 'ValidationError' || err.name === 'CastError' ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
      ...(status < 500 && typeof err.code === 'string' ? { code: err.code } : {}),
    });
  });

  return app;
}
