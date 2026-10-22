import CompanyModel from '../models/Company.js';
import ApplicationModel from '../models/Application.js';
import DraftModel from '../models/Draft.js';
import { PURPOSES } from '../config/profile.js';
import { parseDate } from './importer.js';
import { createRateLimiter } from './rateLimit.js';
import { providerFromEnv } from './outreachAi.js';
import {
  PURPOSE_KEYS, cleanOutreachInput, buildContext, missingFor, buildTemplateDraft, buildPrompt, SYSTEM_PROMPT, validateDraft, parseDraftJson,
} from './outreach.js';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const MAX_DRAFTS_PER_COMPANY = 50;
const day = (d) => new Date(d).toISOString().slice(0, 10);
const BASES = ['verified', 'record', 'you'];

function cleanFacts(facts) {
  if (facts == null) return [];
  if (!Array.isArray(facts) || facts.length > 20) throw fail(400, 'facts must be a short list.');
  return facts.map((f) => {
    if (!f || typeof f !== 'object' || typeof f.label !== 'string' || typeof f.value !== 'string' || !BASES.includes(f.basis)) throw fail(400, 'Invalid fact in facts.');
    return { key: String(f.key || '').slice(0, 40), label: f.label.slice(0, 80), value: f.value.slice(0, 600), basis: f.basis, ...(typeof f.source === 'string' ? { source: f.source.slice(0, 2048) } : {}) };
  });
}

/**
 * Drafting never sends anything. Without an AI provider it uses a template; with one, the AI output is
 * checked against the provided facts and replaced by the template if it states anything unsupported.
 */
export function createOutreachService({
  provider = providerFromEnv(),
  Company = CompanyModel, Application = ApplicationModel, Draft = DraftModel, apps,
  aiLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60_000 }),
} = {}) {
  const config = () => ({
    aiAvailable: !!provider,
    model: provider ? provider.model : null, // never the key
    purposes: PURPOSES.map(({ key, label }) => ({ key, label })),
  });

  async function generate({ companyId, applicationId, purpose, input, useAi }) {
    if (!PURPOSE_KEYS.includes(purpose)) throw fail(400, `purpose must be one of: ${PURPOSE_KEYS.join(', ')}`);
    const clean = cleanOutreachInput(input);
    const company = await Company.findById(companyId).lean();
    if (!company) throw fail(404, 'Company not found.');
    let application = null;
    if (applicationId) {
      application = await Application.findById(applicationId).lean();
      if (!application || String(application.company) !== String(companyId)) throw fail(400, 'That application does not belong to this company.');
    }
    const ctx = buildContext({ company, application, input: clean });
    const missing = missingFor(purpose, ctx);
    if (missing.length) {
      throw fail(422, 'More information is needed before a draft can be written without guessing.', { code: 'missing_context', missing });
    }

    const template = buildTemplateDraft(purpose, ctx, company.name);
    const warnings = [];
    if (!ctx.senderName) warnings.push('Add your name: the draft is signed “[Your name]”.');
    const result = { purpose, facts: ctx.facts, draft: template, generatedBy: 'template', warnings, fallbackReason: null, aiAvailable: !!provider };

    if (useAi) {
      if (!provider) {
        result.fallbackReason = 'ai_not_configured';
        warnings.push('AI is not configured on the server, so the template was used.');
        return result;
      }
      if (!aiLimiter.take('ai')) throw fail(429, 'Too many AI drafts in a short time. Try again in a few minutes, or use the template.', { code: 'rate_limited' });
      try {
        const text = await provider.generate({ system: SYSTEM_PROMPT, user: buildPrompt(purpose, ctx, company.name) });
        const parsed = parseDraftJson(text);
        const check = parsed ? validateDraft(parsed, { ctx, company: company.name }) : { ok: false, problems: ['reply was not valid JSON'] };
        if (check.ok) {
          result.draft = { subject: parsed.subject.trim(), body: parsed.body.trim() };
          result.generatedBy = 'ai';
        } else {
          result.fallbackReason = 'invalid_output';
          result.problems = check.problems;
          warnings.push('The AI draft stated something not supported by your facts, so the template was used instead.');
        }
      } catch (e) {
        // Only a stable code is kept: no provider message, headers or key ever reach the log or the response.
        console.error(`Outreach AI call failed: ${e.code || 'provider_error'}`);
        result.fallbackReason = e.code || 'provider_error';
        warnings.push('The AI service was unavailable, so the template was used.');
      }
    }
    return result;
  }

  async function createDraft(companyId, body = {}) {
    if (!(await Company.exists({ _id: companyId }))) throw fail(404, 'Company not found.');
    if (!PURPOSE_KEYS.includes(body.purpose)) throw fail(400, 'Choose a purpose for this draft.');
    for (const k of ['subject', 'body']) if (typeof body[k] !== 'string' || !body[k].trim()) throw fail(400, `${k} is required.`);
    if (body.subject.length > 200) throw fail(400, 'The subject is too long (200 characters max).');
    if (body.body.length > 5000) throw fail(400, 'The body is too long (5000 characters max).');
    if (body.role != null && (typeof body.role !== 'string' || body.role.length > 200)) throw fail(400, 'role must be short text.');
    const generatedBy = body.generatedBy || 'manual';
    if (!['template', 'ai', 'manual'].includes(generatedBy)) throw fail(400, 'Invalid generatedBy.');
    let application = null;
    if (body.applicationId) {
      const a = await Application.findById(body.applicationId, 'company').lean();
      if (!a || String(a.company) !== String(companyId)) throw fail(400, 'That application does not belong to this company.');
      application = a._id;
    }
    const recent = await Draft.findOne({ company: companyId, subject: body.subject.trim(), body: body.body, createdAt: { $gt: new Date(Date.now() - 30_000) } });
    if (recent) return recent.toObject();
    if ((await Draft.countDocuments({ company: companyId })) >= MAX_DRAFTS_PER_COMPANY) throw fail(400, `This company has ${MAX_DRAFTS_PER_COMPANY} drafts already. Delete some first.`);
    const doc = await Draft.create({
      company: companyId, application, purpose: body.purpose, role: body.role || '', subject: body.subject.trim(), body: body.body,
      generatedBy, facts: cleanFacts(body.facts),
    });
    return doc.toObject();
  }

  async function updateDraft(id, body = {}) {
    const d = await Draft.findById(id);
    if (!d) throw fail(404, 'Draft not found.');
    if (d.status === 'sent') throw fail(409, 'This draft is marked as sent. Mark it as not sent to edit it, or save a new draft.', { code: 'draft_sent' });
    if ('subject' in body) {
      if (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200) throw fail(400, 'subject must be 1 to 200 characters.');
      d.subject = body.subject.trim();
    }
    if ('body' in body) {
      if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 5000) throw fail(400, 'body must be 1 to 5000 characters.');
      d.body = body.body;
    }
    await d.save();
    return d.toObject();
  }

  /** You sent it yourself, outside this app. Record that and (optionally) the contact date on the application. */
  async function markSent(id, { sentAt, updateApplication = true } = {}) {
    const d = await Draft.findById(id);
    if (!d) throw fail(404, 'Draft not found.');
    let when = new Date(`${day(new Date())}T00:00:00Z`);
    if (sentAt != null && sentAt !== '') {
      const parsed = typeof sentAt === 'string' ? parseDate(sentAt.trim()) : null;
      if (!parsed) throw fail(400, 'sentAt must be a real date like 2026-10-31.');
      when = new Date(`${day(parsed)}T00:00:00Z`);
      if (when.getTime() > Date.now() + 86_400_000) throw fail(400, "The sent date can't be in the future.");
    }
    d.status = 'sent';
    d.sentAt = when;
    await d.save();
    let applicationUpdated = false;
    if (updateApplication && d.application && apps) {
      const a = await Application.findById(d.application, 'lastContactDate').lean();
      if (a) {
        if (!a.lastContactDate || when > a.lastContactDate) await apps.update(d.application, { lastContactDate: day(when) });
        await apps.logActivity(d.application, 'outreach', `Outreach email marked as sent on ${day(when)}: “${d.subject}”`);
        applicationUpdated = true;
      }
    }
    return { draft: d.toObject(), applicationUpdated };
  }

  async function markUnsent(id) {
    const d = await Draft.findByIdAndUpdate(id, { $set: { status: 'draft' }, $unset: { sentAt: 1 } }, { new: true }).lean();
    if (!d) throw fail(404, 'Draft not found.');
    return d;
  }

  return {
    config, generate, createDraft, updateDraft, markSent, markUnsent,
    list: (companyId) => Draft.find({ company: companyId }).sort({ createdAt: -1 }).lean(),
    remove: (id) => Draft.findByIdAndDelete(id).lean(),
    removeForCompany: (companyId) => Draft.deleteMany({ company: companyId }),
  };
}
