import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

const input = 'w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40'
const btn = 'rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-stone-50 disabled:opacity-50'
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')
const isHttp = (u) => /^https?:\/\//i.test(u || '')

const BASIS = {
  verified: ['verified on the company site', 'bg-emerald-50 text-emerald-800'],
  record: ['from your records', 'bg-stone-100 text-stone-600'],
  you: ['typed by you', 'bg-sky-50 text-sky-800'],
}
const FALLBACK = {
  ai_not_configured: 'AI is not set up on the server, so this is the template.',
  invalid_output: 'The AI wrote something your facts do not support, so this is the template instead.',
  auth: 'The AI service rejected the server’s key, so this is the template.',
  rate_limited: 'The AI service is busy, so this is the template.',
  network: 'The AI service could not be reached, so this is the template.',
  refused: 'The AI service declined, so this is the template.',
}

const NAME_KEY = 'sf.senderName'
const load = () => { try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' } }
const save = (v) => { try { localStorage.setItem(NAME_KEY, v) } catch { /* private mode: just don't remember it */ } }

function L({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-stone-600">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-stone-500">{hint}</span>}
    </label>
  )
}

export default function OutreachPanel({ company, onApplicationChanged }) {
  const [cfg, setCfg] = useState({ aiAvailable: false, purposes: [] })
  const [apps, setApps] = useState([])
  const [drafts, setDrafts] = useState([])
  const [form, setForm] = useState({ purpose: 'internship_inquiry', applicationId: '', role: '', companyContext: '', listingDetail: '', appliedDate: '', jobUrl: '', senderName: load() })
  const [result, setResult] = useState(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState('')
  const [missing, setMissing] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState({ type: '', text: '' })
  const [open, setOpen] = useState(false)
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); if (k === 'senderName') save(v) }
  const say = (type, text) => setMsg({ type, text })

  const reload = useCallback(async () => {
    try {
      const [a, d] = await Promise.all([api.applications(company._id), api.drafts(company._id)])
      setApps(a.items); setDrafts(d.items)
    } catch (e) { say('err', e.message) }
  }, [company._id])
  useEffect(() => { api.outreachConfig().then(setCfg).catch(() => {}) }, [])
  useEffect(() => { reload() }, [reload])

  const needs = (f) => missing.some((m) => m.field === f)
  const generate = async (useAi) => {
    setBusy(useAi ? 'ai' : 'template'); say('', ''); setMissing([])
    try {
      const payload = Object.fromEntries(Object.entries({ ...form, companyId: company._id, useAi }).filter(([, v]) => v !== ''))
      const r = await api.outreachGenerate(payload)
      setResult(r); setSubject(r.draft.subject); setBody(r.draft.body); setEditingId('')
    } catch (e) {
      if (e.status === 422) { setMissing(e.data.missing || []); say('err', 'Fill in the highlighted details so nothing has to be guessed.') } else say('err', e.message)
    } finally { setBusy('') }
  }

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); say('ok', `${what} copied.${/\[Your name\]/.test(text) ? ' Remember to replace [Your name].' : ''}`) } catch { say('err', `Could not access the clipboard. Select the ${what.toLowerCase()} and copy it manually.`) }
  }

  const saveDraft = async () => {
    setBusy('save'); say('', '')
    try {
      if (editingId) await api.updateDraft(editingId, { subject, body })
      else await api.saveDraft(company._id, { purpose: form.purpose, applicationId: form.applicationId || undefined, subject, body, generatedBy: result?.generatedBy || 'manual', role: form.role || apps.find((a) => a._id === form.applicationId)?.role || '', facts: result?.facts })
      say('ok', editingId ? 'Draft updated.' : 'Draft saved to this company.'); setEditingId(''); await reload()
    } catch (e) { say('err', e.message) } finally { setBusy('') }
  }

  const act = async (fn, ok) => { setBusy('x'); say('', ''); try { await fn(); if (ok) say('ok', ok); await reload() } catch (e) { say('err', e.message) } finally { setBusy('') } }
  const purposeLabel = (k) => cfg.purposes.find((p) => p.key === k)?.label || k

  return (
    <section className="space-y-2" aria-label="Outreach drafts">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Outreach drafts{drafts.length ? ` (${drafts.length})` : ''}</h3>
        <button type="button" className={btn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide' : 'Write a draft'}</button>
      </div>
      <p className="text-xs text-stone-500">Drafts only. This app never sends an email or contacts anyone: copy the text into your own email client, then mark it as sent here.</p>

      {open && (
        <div className="space-y-3 rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <L label="Purpose">
              <select className={input} value={form.purpose} onChange={set('purpose')}>{cfg.purposes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
            </L>
            <L label="Application (optional)" hint="Fills in the role, dates and contact from that application.">
              <select className={input} value={form.applicationId} onChange={set('applicationId')}>
                <option value="">None</option>
                {apps.map((a) => <option key={a._id} value={a._id}>{a.role || 'General application'} ({a.status})</option>)}
              </select>
            </L>
            <L label={`Role${needs('role') ? ' (needed)' : ' (optional)'}`}><input className={`${input} ${needs('role') ? 'border-rose-400' : ''}`} value={form.role} onChange={set('role')} placeholder="e.g. Backend Intern" maxLength={200} /></L>
            <L label="Your name (signature)"><input className={input} value={form.senderName} onChange={set('senderName')} maxLength={100} /></L>
          </div>
          <L label={`I’m interested in ${company.name} because…${needs('companyContext') ? ' (needed)' : ''}`} hint="One true sentence, in your words. It goes into the email as written; nothing is invented. If you leave it empty the company’s industry on record is used.">
            <input className={`${input} ${needs('companyContext') ? 'border-rose-400' : ''}`} value={form.companyContext} onChange={set('companyContext')} maxLength={300} placeholder="e.g. they build agent tooling for warehouses" />
          </L>
          {form.purpose === 'job_listing_response' && (
            <L label="What stood out about the listing (optional)"><input className={input} value={form.listingDetail} onChange={set('listingDetail')} maxLength={300} /></L>
          )}
          {(form.purpose === 'recruiter_follow_up' || needs('appliedDate')) && (
            <L label={`Applied on${needs('appliedDate') ? ' (needed)' : ''}`}><input type="date" className={`${input} ${needs('appliedDate') ? 'border-rose-400' : ''}`} value={form.appliedDate} onChange={set('appliedDate')} /></L>
          )}
          {missing.length > 0 && (
            <ul role="alert" className="list-disc pl-4 text-xs text-rose-700">{missing.map((m) => <li key={m.field}><b>{m.label}:</b> {m.hint}</li>)}</ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={!!busy} onClick={() => generate(false)}>{busy === 'template' ? 'Writing…' : 'Generate from template'}</button>
            <button type="button" className={btn} disabled={!!busy || !cfg.aiAvailable} onClick={() => generate(true)} title={cfg.aiAvailable ? 'Uses the AI service configured on the server; sends the facts below to it' : 'Set ANTHROPIC_API_KEY in server/.env to enable'}>
              {busy === 'ai' ? 'Writing…' : 'Generate with AI'}
            </button>
            {!cfg.aiAvailable && <span className="self-center text-[11px] text-stone-500">AI not configured: templates only.</span>}
          </div>

          {result && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-1.5 py-0.5 font-medium ${result.generatedBy === 'ai' ? 'bg-violet-50 text-violet-800' : 'bg-stone-200 text-stone-700'}`}>
                  Generated text: {result.generatedBy === 'ai' ? 'AI' : 'template'}
                </span>
                <span className="text-stone-500">Review and edit before you use it.</span>
              </div>
              {result.fallbackReason && <p className="text-xs text-amber-800">{FALLBACK[result.fallbackReason] || 'The AI was unavailable, so this is the template.'}</p>}
              {result.warnings.filter((w) => !result.fallbackReason || !/AI|template/i.test(w)).map((w) => <p key={w} className="text-xs text-amber-800">{w}</p>)}
              <L label="Subject"><input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></L>
              <L label="Body"><textarea rows={12} className={`${input} font-mono text-[13px]`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} /></L>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} onClick={() => copy(subject, 'Subject')}>Copy subject</button>
                <button type="button" className={btn} onClick={() => copy(body, 'Body')}>Copy body</button>
                <button type="button" className={btn} disabled={!!busy || !subject.trim() || !body.trim()} onClick={saveDraft}>{editingId ? 'Update saved draft' : 'Save draft'}</button>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-stone-700">Facts used ({result.facts.length}): the only company details the draft may state</summary>
                <ul className="mt-1 space-y-1">
                  {result.facts.map((f, i) => (
                    <li key={i}>
                      <span className="text-stone-500">{f.label}:</span> {f.value}{' '}
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${BASIS[f.basis][1]}`}>{BASIS[f.basis][0]}</span>
                      {f.source && isHttp(f.source) && <> <a className="text-accent underline" href={f.source} target="_blank" rel="noopener noreferrer">source ↗</a></>}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-stone-500">Funding and your private notes are never used. Anything not listed here is not claimed in the draft.</p>
              </details>
            </div>
          )}
        </div>
      )}

      {msg.text && <p role={msg.type === 'err' ? 'alert' : 'status'} className={`text-xs ${msg.type === 'err' ? 'text-rose-700' : 'text-emerald-700'}`}>{msg.text}</p>}

      {drafts.length > 0 && (
        <ul className="space-y-1.5">
          {drafts.map((d) => (
            <li key={d._id} className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.subject}</span>
                <span className="text-stone-500">{purposeLabel(d.purpose)} · saved {day(d.createdAt)}{d.generatedBy !== 'manual' ? ` · ${d.generatedBy}` : ''}</span>
                {d.status === 'sent' && <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800">Sent manually {day(d.sentAt)}</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {d.status === 'draft' && (
                  <button className={btn} disabled={!!busy} onClick={() => { setOpen(true); setEditingId(d._id); setSubject(d.subject); setBody(d.body); setResult({ draft: d, facts: d.facts || [], generatedBy: d.generatedBy, warnings: [], fallbackReason: null }); setForm((f) => ({ ...f, purpose: d.purpose })) }}>Open</button>
                )}
                <button className={btn} onClick={() => copy(d.body, 'Body')}>Copy body</button>
                {d.status === 'draft' ? (
                  <button className={btn} disabled={!!busy} title="Only records that YOU sent it yourself" onClick={() => window.confirm('Mark this draft as sent? This only records that you sent it yourself; the app sends nothing.') && act(async () => { const r = await api.markDraftSent(d._id, { updateApplication: true }); if (r.applicationUpdated) await onApplicationChanged() }, 'Marked as sent today.')}>I sent this</button>
                ) : (
                  <button className={btn} disabled={!!busy} onClick={() => act(() => api.markDraftUnsent(d._id), 'Marked as not sent.')}>Mark not sent</button>
                )}
                <button className="text-rose-700 hover:underline" disabled={!!busy} onClick={() => window.confirm('Delete this draft?') && act(() => api.removeDraft(d._id), 'Draft deleted.')}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
