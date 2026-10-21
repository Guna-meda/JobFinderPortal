import mongoose from 'mongoose';
import { stringify } from 'csv-stringify/sync';
import Company from '../models/Company.js';
import Application from '../models/Application.js';
import { STATUSES } from '../lib/csv.js';
import { guardCell } from '../lib/exportCsv.js';
import { TERMINAL, startOfDay, isOverdue } from '../lib/applications.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (id) => mongoose.isValidObjectId(id);
const one = (v) => (Array.isArray(v) ? v[0] : v);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function conflictBody(e) {
  return { error: e.message, code: e.code, ...(e.existing ? { existing: e.existing } : {}) };
}

export function registerApplications(app, { wrap, apps }) {
  const withErrors = (fn) => wrap(async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status === 409) return res.status(409).json(conflictBody(e));
      throw e;
    }
  });

  app.get('/api/companies/:id/applications', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json({ items: await apps.list(req.params.id) });
  }));

  app.post('/api/companies/:id/applications', withErrors(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.status(201).json(await apps.create(req.params.id, req.body));
  }));

  app.patch('/api/applications/:id', withErrors(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json(await apps.update(req.params.id, req.body));
  }));

  app.delete('/api/applications/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    if (!(await apps.remove(req.params.id))) return res.status(404).json({ error: 'Application not found.' });
    res.status(204).end();
  }));

  // A manual entry in the activity history ("emailed the recruiter", "phone screen booked", ...).
  app.post('/api/applications/:id/activity', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.status(201).json(await apps.addNote(req.params.id, req.body?.note));
  }));

  // Applications across companies, e.g. the follow-ups due list. Query values are validated, never passed through.
  app.get('/api/applications', wrap(async (req, res) => {
    const q = {};
    const status = one(req.query.status);
    if (status) {
      if (!STATUSES.includes(status)) throw bad('Invalid status.');
      q.status = status;
    }
    if (one(req.query.followUpDue) === 'true') {
      q.followUpDate = { $lte: new Date() };
      // Finished applications (Rejected, Offer) are never "due".
      q.status = !status ? { $nin: TERMINAL } : TERMINAL.includes(status) ? { $in: [] } : status;
    }
    const limit = Math.min(Math.max(Number(one(req.query.limit)) || 50, 1), 200);
    const items = await Application.find(q).sort({ followUpDate: 1, updatedAt: -1 }).limit(limit).lean();
    const names = new Map((await Company.find({ _id: { $in: items.map((a) => a.company) } }, 'name').lean()).map((c) => [String(c._id), c.name]));
    const now = new Date();
    res.json({
      items: items.map((a) => ({ ...a, companyName: names.get(String(a.company)) || '', overdue: isOverdue(a, now), daysOverdue: isOverdue(a, now) ? Math.round((startOfDay(now) - startOfDay(a.followUpDate)) / 86_400_000) : 0 })),
      total: await Application.countDocuments(q),
    });
  }));

  app.get('/api/applications/export', wrap(async (req, res) => {
    const items = await Application.find({}).sort({ company: 1, createdAt: 1 }).lean();
    const names = new Map((await Company.find({}, 'name').lean()).map((c) => [String(c._id), c.name]));
    const headers = ['Company', 'Role', 'Job URL', 'Status', 'Applied Date', 'Last Contact', 'Follow-up Date', 'Contact Name', 'Contact Email', 'Contact URL', 'Next Action', 'Notes', 'Created', 'Updated', 'Activity'];
    const rows = items.map((a) => [
      names.get(String(a.company)) || '', a.role, a.jobUrl, a.status, day(a.appliedDate), day(a.lastContactDate), day(a.followUpDate),
      a.contactName, a.contactEmail, a.contactUrl, a.nextAction, a.notes, new Date(a.createdAt).toISOString(), new Date(a.updatedAt).toISOString(),
      (a.history || []).map((h) => `${day(h.at)} ${h.summary}`).join(' | '),
    ].map(guardCell));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="applications.csv"');
    res.send('﻿' + stringify([headers, ...rows]));
  }));
}
