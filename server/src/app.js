import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { stringify } from 'csv-stringify/sync';
import mongoose from 'mongoose';
import Company from './models/Company.js';
import { buildFilter, sortFor } from './lib/filters.js';
import {
  parseCompanies,
  normalizeUrl,
  domainOf,
  STATUSES,
  FUNDING_STATUSES,
  FUNDING_STAGES,
} from './lib/csv.js';
import { researchCompany } from './lib/research.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (id) => mongoose.isValidObjectId(id);

const EDITABLE = [
  'name', 'website', 'location', 'industry', 'fundingStatus', 'fundingStage', 'fundingSourceUrl', 'fundingVerified',
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

const csvDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export function createApp() {
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
    const [total, researched, byStatus, followUpsDue, withRoles] = await Promise.all([
      Company.countDocuments(),
      Company.countDocuments({ researchStatus: { $in: ['researched', 'partial'] } }),
      Company.aggregate([{ $group: { _id: '$appStatus', n: { $sum: 1 } } }]),
      Company.countDocuments({ followUpDate: { $lte: new Date() }, appStatus: { $in: ['Applied', 'Replied', 'Interview'] } }),
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
      withRoles,
      byStatus: s,
    });
  }));

  app.post('/api/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw bad('Attach a CSV file in the "file" field.');
    let parsed;
    try {
      parsed = parseCompanies(req.file.buffer.toString('utf8'));
    } catch (e) {
      throw bad(e.message);
    }
    const existing = await Company.find({}, 'name domain').lean();
    const byDomain = new Map(existing.filter((c) => c.domain).map((c) => [c.domain, c._id]));
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c._id]));
    let inserted = 0, updated = 0, skipped = 0;
    const toInsert = [];
    const fillOps = [];
    const seen = new Set();
    for (const c of parsed.companies) {
      const key = c.domain || c.name.toLowerCase();
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const id = (c.domain && byDomain.get(c.domain)) || byName.get(c.name.toLowerCase());
      if (!id) { toInsert.push(c); continue; }
      // Existing record: only fill fields that are currently blank. Never overwrite user edits.
      const doc = await Company.findById(id);
      let changed = false;
      for (const f of ['website', 'domain', 'location', 'industry', 'careersUrl', 'contactEmail', 'notes']) {
        if (!doc[f] && c[f]) { doc[f] = c[f]; changed = true; }
      }
      if (changed) { fillOps.push(doc.save()); updated++; } else skipped++;
    }
    if (toInsert.length) { await Company.insertMany(toInsert, { ordered: false }); inserted = toInsert.length; }
    await Promise.all(fillOps);
    res.json({ inserted, updated, skipped, errors: parsed.errors, unmapped: parsed.unmapped, mapping: parsed.mapping });
  }));

  app.get('/api/export', wrap(async (req, res) => {
    const items = await Company.find(buildFilter(req.query)).sort(sortFor(req.query.sort)).lean();
    const rows = items.map((c) => ({
      Company: c.name,
      Website: c.website,
      Location: c.location,
      Industry: c.industry,
      'Funding Status': c.fundingStatus,
      'Funding Stage': c.fundingStage,
      'Funding Source URL': c.fundingSourceUrl,
      'Funding Verified': c.fundingVerified ? 'yes' : 'no',
      'Careers URL': c.careersUrl,
      'Careers Source URL': c.careersSourceUrl,
      'Contact Email': c.contactEmail,
      'Contact Email Source URL': c.contactEmailSourceUrl,
      'Contact Name': c.contactName,
      'Relevant Roles': c.hasRelevantRoles,
      'Open Roles': (c.openRoles || []).map((r) => `${r.title} (${r.url})`).join(' | '),
      'Research Status': c.researchStatus,
      'Researched At': csvDate(c.researchedAt),
      'Application Status': c.appStatus,
      'Applied Date': csvDate(c.appliedDate),
      'Follow-up Date': csvDate(c.followUpDate),
      Notes: c.notes,
    }));
    // Prefix cells starting with = + - @ to avoid spreadsheet formula injection.
    const safe = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v])));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="startups.csv"');
    res.send('﻿' + stringify(safe, { header: true, columns: rows.length ? undefined : ['Company'] }));
  }));

  app.post('/api/companies', wrap(async (req, res) => {
    const patch = cleanPatch(req.body);
    if (!patch.name) throw bad('Company name is required.');
    res.status(201).json(await Company.create(patch));
  }));

  app.get('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const c = await Company.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    res.json(c);
  }));

  app.patch('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const c = await Company.findByIdAndUpdate(req.params.id, { $set: cleanPatch(req.body) }, { new: true, runValidators: true }).lean();
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    res.json(c);
  }));

  app.delete('/api/companies/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    await Company.findByIdAndDelete(req.params.id);
    res.status(204).end();
  }));

  app.post('/api/companies/:id/research', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const c = await Company.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    const r = await researchCompany(c);
    const { researchStatus, researchLog, ...found } = r;
    Object.assign(c, found, { researchStatus, researchLog, researchedAt: new Date() });
    await c.save();
    res.json(c);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (10 MB max).' });
    const status = err.status || (err.name === 'ValidationError' || err.name === 'CastError' ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
  });

  return app;
}
