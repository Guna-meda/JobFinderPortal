import mongoose from 'mongoose';
import Company from '../models/Company.js';
import { researchConfig } from '../config/research.js';

const bad = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
const isId = (id) => mongoose.isValidObjectId(id);
const ACTIONS = ['accept', 'reject', 'reset'];

export function registerResearch(app, { wrap, service, config = researchConfig }) {
  app.get('/api/research/config', (req, res) => {
    res.json({
      roleKeywords: config.roleKeywords,
      staleDays: config.staleDays,
      maxPages: config.maxPages,
      maxRequests: config.maxRequests,
      minIntervalMs: config.minIntervalMs,
      batchLimit: config.batchLimit,
    });
  });

  // Start research for one company. Returns 202 immediately; poll the company for progress.
  app.post('/api/companies/:id/research', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const c = await Company.findById(req.params.id, 'website').lean();
    if (!c) return res.status(404).json({ error: 'Company not found.' });
    if (!c.website) throw bad('Add a website to this company first.');
    const r = await service.start(req.params.id);
    if (r.conflict) return res.status(409).json({ error: 'Research is already running for this company.', code: 'already_running' });
    res.status(202).json(r.company);
  }));

  // Start research for several selected companies. They are queued and run a couple at a time.
  app.post('/api/research/batch', wrap(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw bad('Select at least one company.');
    if (ids.length > config.batchLimit) throw bad(`Select at most ${config.batchLimit} companies at a time.`);
    if (!ids.every((i) => typeof i === 'string' && isId(i))) throw bad('Invalid id in selection.');
    const started = [];
    const skipped = [];
    for (const id of [...new Set(ids)]) {
      const c = await Company.findById(id, 'website').lean();
      if (!c) skipped.push({ id, reason: 'not found' });
      else if (!c.website) skipped.push({ id, reason: 'no website' });
      else if ((await service.start(id)).conflict) skipped.push({ id, reason: 'already running' });
      else started.push(id);
    }
    res.status(202).json({ started, skipped });
  }));

  // accept | reject | reset one finding. Accepting never replaces a different existing value unless overwrite=true.
  app.post('/api/companies/:id/findings/:fid', wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.fid)) throw bad('Invalid id.');
    const { action, value, overwrite } = req.body || {};
    if (!ACTIONS.includes(action)) throw bad('action must be accept, reject or reset.');
    try {
      const r = await service.decide(req.params.id, req.params.fid, { action, value, overwrite: overwrite === true });
      if (r.notFound) return res.status(404).json({ error: `${r.notFound === 'company' ? 'Company' : 'Finding'} not found.` });
      res.json(r.company);
    } catch (e) {
      if (e.conflict) return res.status(409).json({ error: e.message, code: 'conflict', conflict: e.conflict });
      throw e;
    }
  }));

  app.post('/api/companies/:id/findings', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    const { action, ids } = req.body || {};
    if (!ACTIONS.includes(action)) throw bad('action must be accept, reject or reset.');
    if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === 'string' && isId(i))) throw bad('ids must be a list of finding ids.');
    const r = await service.decideMany(req.params.id, ids, { action });
    if (r.notFound) return res.status(404).json({ error: 'Company not found.' });
    res.json({ company: r.company, changed: r.changed, skipped: r.skipped });
  }));
}
