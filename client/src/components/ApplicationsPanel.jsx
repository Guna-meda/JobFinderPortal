import { useCallback, useEffect, useState } from 'react'
import { api, STATUSES } from '../api'
import { followUpLabel, statusTone } from '../tracking'

const input = 'w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40'
const btn = 'rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-stone-50 disabled:opacity-50'
const isHttp = (u) => /^https?:\/\//i.test(u || '')
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')

const FIELDS = ['role', 'jobUrl', 'appliedDate', 'lastContactDate', 'followUpDate', 'contactName', 'contactEmail', 'contactUrl', 'nextAction', 'notes']
const toForm = (a) => ({
  role: a.role || '', jobUrl: a.jobUrl || '', appliedDate: day(a.appliedDate), lastContactDate: day(a.lastContactDate), followUpDate: day(a.followUpDate),
  contactName: a.contactName || '', contactEmail: a.contactEmail || '', contactUrl: a.contactUrl || '', nextAction: a.nextAction || '', notes: a.notes || '',
})

function L({ label, children }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-stone-600">{label}</span>
      {children}
    </label>
  )
}

function ApplicationCard({ a, onChanged, openByDefault }) {
  const [open, setOpen] = useState(!!openByDefault)
  const [form, setForm] = useState(() => toForm(a))
  const [base, setBase] = useState(() => toForm(a))
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const fu = followUpLabel(a)

  const run = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('')
    try { const r = await fn(); if (ok) setMsg(ok); await onChanged(); return r } catch (e) { setErr(e.message); return null } finally { setBusy(false) }
  }

  const save = async (e) => {
    e.preventDefault()
    const patch = Object.fromEntries(FIELDS.filter((k) => form[k] !== base[k]).map((k) => [k, form[k]]))
    if (!Object.keys(patch).length) { setMsg('No changes.'); return }
    const r = await run(() => api.updateApplication(a._id, patch), 'Saved.')
    if (r) { const next = toForm(r); setForm(next); setBase(next) }
  }

  // Quick status change: the server fills the applied/contact dates and records the change in the history.
  const changeStatus = async (status) => {
    const r = await run(() => api.updateApplication(a._id, { status }))
    if (r) { const next = toForm(r); setForm(next); setBase(next) }
  }

  return (
    <li className="rounded-md border border-stone-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium">{a.role || 'General application'}</span>
          <span className="block text-xs text-stone-500">
            {a.appliedDate ? `applied ${day(a.appliedDate)}` : 'not applied yet'}
            {a.lastContactDate ? ` · last contact ${day(a.lastContactDate)}` : ''}
          </span>
        </button>
        {fu && <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${fu.tone}`}>{fu.text}</span>}
        <select
          aria-label={`Status for ${a.role || 'general application'}`} value={a.status} disabled={busy}
          onChange={(e) => changeStatus(e.target.value)}
          className={`rounded-full border-0 px-2 py-1 text-xs font-medium ${statusTone[a.status]}`}
        >
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {err && !open && <p role="alert" className="px-3 pb-2 text-xs text-rose-700">{err}</p>}

      {open && (
        <div className="space-y-3 border-t border-stone-100 px-3 py-3">
          {a.nextAction && <p className="text-xs"><b>Next action:</b> {a.nextAction}</p>}
          {isHttp(a.jobUrl) && <p className="text-xs"><a className="text-accent underline" href={a.jobUrl} target="_blank" rel="noopener noreferrer">Job posting ↗</a></p>}
          <form onSubmit={save} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <L label="Role / title"><input className={input} value={form.role} onChange={set('role')} maxLength={200} /></L>
              <L label="Job posting URL"><input className={input} value={form.jobUrl} onChange={set('jobUrl')} placeholder="https://…" /></L>
              <L label="Applied on"><input type="date" className={input} value={form.appliedDate} onChange={set('appliedDate')} /></L>
              <L label="Last contact"><input type="date" className={input} value={form.lastContactDate} onChange={set('lastContactDate')} /></L>
              <L label="Next follow-up"><input type="date" className={input} value={form.followUpDate} onChange={set('followUpDate')} /></L>
              <L label="Next action"><input className={input} value={form.nextAction} onChange={set('nextAction')} maxLength={300} placeholder="e.g. Email the recruiter" /></L>
              <L label="Contact name"><input className={input} value={form.contactName} onChange={set('contactName')} /></L>
              <L label="Contact email (public/professional)"><input type="email" className={input} value={form.contactEmail} onChange={set('contactEmail')} /></L>
              <L label="Contact profile URL"><input className={input} value={form.contactUrl} onChange={set('contactUrl')} placeholder="LinkedIn or similar" /></L>
            </div>
            <L label="Notes"><textarea rows={3} className={input} value={form.notes} onChange={set('notes')} maxLength={5000} /></L>
            <div className="flex items-center gap-2">
              <button className={btn} disabled={busy}>Save application</button>
              <button
                type="button" className="text-xs text-rose-700 hover:underline" disabled={busy}
                onClick={() => window.confirm(`Delete this application${a.role ? ` (${a.role})` : ''} and its history? This cannot be undone.`) && run(() => api.removeApplication(a._id))}
              >Delete</button>
              {msg && <span role="status" className="text-xs text-emerald-700">{msg}</span>}
            </div>
            {err && <p role="alert" className="text-xs text-rose-700">{err}</p>}
          </form>

          <div>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500">Activity</h4>
            <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-stone-600">
              {[...(a.history || [])].reverse().map((h, i) => (
                <li key={i}><span className="tabular-nums text-stone-400">{day(h.at)}</span> {h.summary}</li>
              ))}
            </ul>
            <form
              className="mt-1.5 flex gap-1.5"
              onSubmit={async (e) => { e.preventDefault(); if (note.trim() && await run(() => api.addActivity(a._id, note))) setNote('') }}
            >
              <input aria-label="Add an activity note" className={input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Log something (e.g. emailed the recruiter)" />
              <button className={btn} disabled={busy || !note.trim()}>Log</button>
            </form>
          </div>
        </div>
      )}
    </li>
  )
}

export default function ApplicationsPanel({ company, onCompanyChanged, reloadKey = 0 }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ role: '', jobUrl: '', status: 'To Apply', followUpDate: '', nextAction: '' })
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')
  const [justAdded, setJustAdded] = useState('')

  const load = useCallback(async () => {
    try { setItems((await api.applications(company._id)).items); setError('') } catch (e) { setError(e.message) }
  }, [company._id])
  useEffect(() => { load() }, [load, reloadKey])

  // After any change, reload the list and refresh the company's summary (status, dates, count) in the parent.
  const changed = useCallback(async () => { await load(); onCompanyChanged(await api.company(company._id)) }, [load, onCompanyChanged, company._id])

  const add = async (e) => {
    e.preventDefault()
    setSaving(true); setFormErr('')
    try {
      const body = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''))
      const created = await api.addApplication(company._id, body)
      setJustAdded(created._id); setAdding(false)
      setDraft({ role: '', jobUrl: '', status: 'To Apply', followUpDate: '', nextAction: '' })
      await changed()
    } catch (err) { setFormErr(err.message) } finally { setSaving(false) }
  }

  return (
    <section className="space-y-2" aria-label="Applications">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Applications{items ? ` (${items.length})` : ''}</h3>
        <button type="button" className={btn} onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : 'Add application'}</button>
      </div>
      <p className="text-xs text-stone-500">One entry per role, each with its own status. Nothing here sends an application or an email: it is your tracker.</p>

      {adding && (
        <form onSubmit={add} className="space-y-2 rounded-md border border-dashed border-stone-300 bg-stone-50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <L label="Role / title"><input autoFocus className={input} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} maxLength={200} placeholder="Leave empty for a general application" /></L>
            <L label="Job posting URL"><input className={input} value={draft.jobUrl} onChange={(e) => setDraft({ ...draft, jobUrl: e.target.value })} placeholder="https://…" /></L>
            <L label="Status">
              <select className={input} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
            </L>
            <L label="Next follow-up"><input type="date" className={input} value={draft.followUpDate} onChange={(e) => setDraft({ ...draft, followUpDate: e.target.value })} /></L>
          </div>
          <L label="Next action"><input className={input} value={draft.nextAction} onChange={(e) => setDraft({ ...draft, nextAction: e.target.value })} maxLength={300} /></L>
          {formErr && <p role="alert" className="text-xs text-rose-700">{formErr}</p>}
          <button className={btn} disabled={saving}>{saving ? 'Adding…' : 'Add'}</button>
        </form>
      )}

      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
      {items === null && !error && <p className="text-xs text-stone-500">Loading applications…</p>}
      {items && items.length === 0 && !adding && (
        <p className="rounded-md border border-dashed border-stone-300 p-3 text-xs text-stone-500">No applications yet. Add one when you decide to apply for a role.</p>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((a) => <ApplicationCard key={a._id} a={a} onChanged={changed} openByDefault={a._id === justAdded} />)}
        </ul>
      )}
    </section>
  )
}
