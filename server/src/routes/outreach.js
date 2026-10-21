import mongoose from 'mongoose';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isId = (id) => mongoose.isValidObjectId(id);

export function registerOutreach(app, { wrap, outreach }) {
  app.get('/api/outreach/config', (req, res) => res.json(outreach.config()));

  // Writes a draft. Never sends anything, anywhere.
  app.post('/api/outreach/generate', wrap(async (req, res) => {
    const b = req.body || {};
    if (!isId(b.companyId)) throw bad('Choose a company.');
    if (b.applicationId != null && b.applicationId !== '' && !isId(b.applicationId)) throw bad('Invalid application.');
    try {
      res.json(await outreach.generate({
        companyId: b.companyId, applicationId: b.applicationId || null, purpose: b.purpose, input: b, useAi: b.useAi === true,
      }));
    } catch (e) {
      if (e.status === 422) return res.status(422).json({ error: e.message, code: e.code, missing: e.missing });
      if (e.status === 429) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: e.message, code: e.code }); }
      throw e;
    }
  }));

  app.get('/api/companies/:id/drafts', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json({ items: await outreach.list(req.params.id) });
  }));

  app.post('/api/companies/:id/drafts', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.status(201).json(await outreach.createDraft(req.params.id, req.body));
  }));

  app.patch('/api/drafts/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json(await outreach.updateDraft(req.params.id, req.body));
  }));

  // "I sent this myself": records the date, and optionally the contact date and an activity entry.
  app.post('/api/drafts/:id/sent', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json(await outreach.markSent(req.params.id, { sentAt: req.body?.sentAt, updateApplication: req.body?.updateApplication !== false }));
  }));

  app.post('/api/drafts/:id/unsent', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    res.json(await outreach.markUnsent(req.params.id));
  }));

  app.delete('/api/drafts/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) throw bad('Invalid id.');
    if (!(await outreach.remove(req.params.id))) return res.status(404).json({ error: 'Draft not found.' });
    res.status(204).end();
  }));
}
