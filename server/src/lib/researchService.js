import Company from '../models/Company.js';
import { researchConfig } from '../config/research.js';
import { defaultFetcher } from './safeFetch.js';
import { runResearch, describeError } from './researchRun.js';
import { mergeFindings, applyFinding } from './findings.js';

function createQueue(concurrency) {
  let active = 0;
  const waiting = [];
  const idle = [];
  const settle = () => {
    if (!active && !waiting.length) idle.splice(0).forEach((r) => r());
  };
  const next = () => {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      active++;
      job().finally(() => {
        active--;
        next();
        settle();
      });
    }
  };
  return {
    push(job) {
      waiting.push(job);
      next();
    },
    onIdle: () => (!active && !waiting.length ? Promise.resolve() : new Promise((r) => idle.push(r))),
  };
}

/**
 * Orchestrates research: per-company lock (no duplicate concurrent runs), a small worker pool,
 * persistence of findings, and accept/reject decisions. The fetcher and config are injectable for tests.
 */
export function createResearchService({ fetcher = defaultFetcher, config = researchConfig, model = Company } = {}) {
  const queue = createQueue(config.concurrency);

  // Atomic: only one caller can move a company to 'running'. A marker older than lockMs is a crashed run.
  async function claim(id) {
    const cutoff = new Date(Date.now() - config.lockMs);
    return model
      .findOneAndUpdate(
        { _id: id, $or: [{ researchStatus: { $ne: 'running' } }, { researchStartedAt: { $lt: cutoff } }] },
        { $set: { researchStatus: 'running', researchStartedAt: new Date(), researchProgress: 'Queued' }, $unset: { researchError: 1 } },
        { new: true }
      )
      .lean();
  }

  const progress = (id, message) =>
    model.updateOne({ _id: id, researchStatus: 'running' }, { $set: { researchProgress: message } }).catch(() => {});

  async function execute(id) {
    const company = await model.findById(id).lean();
    if (!company) return null;
    let run;
    try {
      run = await runResearch({ company, fetcher, config, onProgress: (m) => progress(id, m) });
    } catch (e) {
      console.error('research crashed', e); // details stay in the server log
      run = { status: 'failed', error: describeError(e), findings: [], notFound: [], log: ['Stopped: unexpected error'], pages: 0 };
    }
    const fresh = await model.findById(id).lean();
    if (!fresh) return null;
    const set = {
      researchStatus: run.status,
      researchedAt: new Date(),
      researchProgress: '',
      researchNotFound: run.notFound,
      researchPages: run.pages,
      researchLog: run.log,
    };
    const unset = { researchStartedAt: 1 };
    if (run.status === 'failed') set.researchError = run.error;
    else unset.researchError = 1;
    // Failed and partial runs did not read everything, so they must not flag earlier findings as "not re-observed".
    const complete = run.status === 'researched' || run.status === 'not_found';
    if (run.findings.length || complete) {
      set.findings = mergeFindings(fresh.findings || [], run.findings, { max: config.maxFindings, markUnseen: complete });
    }
    await model.updateOne({ _id: id }, { $set: set, $unset: unset });
    return model.findById(id).lean();
  }

  async function safeExecute(id) {
    try {
      return await execute(id);
    } catch (e) {
      console.error('research bookkeeping failed', e);
      await model
        .updateOne({ _id: id }, { $set: { researchStatus: 'failed', researchError: describeError(e), researchProgress: '' }, $unset: { researchStartedAt: 1 } })
        .catch(() => {});
      return null;
    }
  }

  return {
    /** Mark running and queue the work; returns immediately. */
    async start(id) {
      const company = await claim(id);
      if (!company) return { conflict: true };
      queue.push(() => safeExecute(id));
      return { company };
    },
    /** Same, but waits for the result (used by tests). */
    async runNow(id) {
      const company = await claim(id);
      if (!company) return { conflict: true };
      return { company: await safeExecute(id) };
    },
    onIdle: () => queue.onIdle(),
    /** On server start nothing can still be running, so any 'running' marker is a leftover. */
    async recoverInterrupted() {
      const r = await model.updateMany(
        { researchStatus: 'running' },
        { $set: { researchStatus: 'failed', researchProgress: '', researchError: { code: 'interrupted', message: 'Research was interrupted by a server restart. Retry it.', retryable: true } }, $unset: { researchStartedAt: 1 } }
      );
      return r.modifiedCount;
    },

    /**
     * accept | reject | reset a finding. Accepting applies it to the company; a different existing value is never
     * replaced unless overwrite is true (the caller gets a Conflict otherwise).
     */
    async decide(id, findingId, { action, value, overwrite = false }) {
      const doc = await model.findById(id);
      if (!doc) return { notFound: 'company' };
      const f = doc.findings.id(findingId);
      if (!f) return { notFound: 'finding' };
      decideOn(doc, f, { action, value, overwrite });
      await doc.save();
      return { company: doc.toObject() };
    },

    /** Same decision for several findings; conflicts are skipped and reported instead of aborting. */
    async decideMany(id, ids, { action }) {
      const doc = await model.findById(id);
      if (!doc) return { notFound: 'company' };
      const skipped = [];
      let changed = 0;
      for (const fid of ids) {
        const f = doc.findings.id(fid);
        if (!f) {
          skipped.push({ id: fid, reason: 'not found' });
          continue;
        }
        try {
          decideOn(doc, f, { action, overwrite: false });
          changed++;
        } catch (e) {
          if (!e.conflict && !e.status) throw e;
          skipped.push({ id: fid, reason: e.message });
        }
      }
      await doc.save();
      return { company: doc.toObject(), changed, skipped };
    },
  };
}

function decideOn(doc, f, { action, value, overwrite }) {
  if (!['accept', 'reject', 'reset'].includes(action)) throw Object.assign(new Error('action must be accept, reject or reset.'), { status: 400 });
  if (action === 'accept') {
    if (f.status === 'accepted') return;
    doc.set(applyFinding(doc.toObject(), f.toObject(), { value, overwrite }));
    f.status = 'accepted';
  } else {
    if (f.status === 'accepted') throw Object.assign(new Error('This finding was already accepted. Edit the field directly to change it.'), { status: 400 });
    f.status = action === 'reject' ? 'rejected' : 'pending';
  }
  f.decidedAt = new Date();
}
