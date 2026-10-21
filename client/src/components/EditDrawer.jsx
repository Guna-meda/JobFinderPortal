import { useState } from 'react'
import { FUNDING_STATUSES, FUNDING_STAGES } from '../api'
import ResearchPanel from './ResearchPanel'
import ApplicationsPanel from './ApplicationsPanel'

const input = 'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40'

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  )
}

const initial = (c) => ({
  name: c.name, website: c.website || '', location: c.location || '', industry: c.industry || '',
  fundingStatus: c.fundingStatus, fundingStage: c.fundingStage, fundingAmount: c.fundingAmount || '', fundingDate: c.fundingDate || '',
  fundingSourceUrl: c.fundingSourceUrl || '', fundingVerified: !!c.fundingVerified,
  careersUrl: c.careersUrl || '', contactEmail: c.contactEmail || '', contactName: c.contactName || '',
  hasRelevantRoles: c.hasRelevantRoles, notes: c.notes || '',
})

export default function EditDrawer({ company: c, onClose, onSave, onCompany, onDelete }) {
  const [f, setF] = useState(() => initial(c))
  // What the server last told us. Only fields that differ from this are saved, so values applied from
  // research (accepted findings) are never overwritten by an older copy sitting in the form.
  const [base, setBase] = useState(() => initial(c))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState({ type: '', text: '' })
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const save = async (e) => {
    e.preventDefault()
    const patch = Object.fromEntries(Object.keys(f).filter((k) => f[k] !== base[k]).map((k) => [k, f[k]]))
    if (!Object.keys(patch).length) { setMsg({ type: 'ok', text: 'No changes to save.' }); return }
    setSaving(true); setMsg({ type: '', text: '' })
    try {
      await onSave(patch)
      setBase((b) => ({ ...b, ...patch }))
      setMsg({ type: 'ok', text: 'Saved.' })
    } catch (err) { setMsg({ type: 'err', text: err.message }) } finally { setSaving(false) }
  }

  // The research panel changed the company on the server: pull those values into the form
  // unless the user has typed a different value of their own in that field.
  const serverChanged = (updated) => {
    const next = initial(updated)
    setF((x) => Object.fromEntries(Object.keys(x).map((k) => [k, x[k] === base[k] ? next[k] : x[k]])))
    setBase(next)
    onCompany(updated)
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/30" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{c.name}</h2>
            <p className="text-xs text-stone-500">Company details, applications and research</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-xl leading-none text-stone-400 hover:text-ink">×</button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <ApplicationsPanel company={c} onCompanyChanged={onCompany} />

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Company contact and notes</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact name"><input className={input} value={f.contactName} onChange={set('contactName')} /></Field>
              <Field label="Contact email"><input type="email" className={input} value={f.contactEmail} onChange={set('contactEmail')} /></Field>
            </div>
            <Field label="Notes"><textarea rows={4} className={input} value={f.notes} onChange={set('notes')} /></Field>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Company</h3>
            <Field label="Name"><input required className={input} value={f.name} onChange={set('name')} /></Field>
            <Field label="Website"><input className={input} value={f.website} onChange={set('website')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Location"><input className={input} value={f.location} onChange={set('location')} /></Field>
              <Field label="Industry"><input className={input} value={f.industry} onChange={set('industry')} /></Field>
            </div>
            <Field label="Careers URL" hint={c.careersVerified ? 'Found on the official site by research (source recorded).' : undefined}>
              <input className={input} value={f.careersUrl} onChange={set('careersUrl')} />
            </Field>
            <Field label="Engineering roles">
              <select className={input} value={f.hasRelevantRoles} onChange={set('hasRelevantRoles')}>
                <option value="unknown">Unknown</option><option value="yes">Has relevant roles</option><option value="no">No relevant roles</option>
              </select>
            </Field>
            {c.openRoles?.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-xs">
                {c.openRoles.map((r) => (
                  <li key={r.url || r.title}>
                    {r.url ? <a className="text-accent underline" href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}
                    {r.sourceUrl && <span className="text-stone-400"> · from research</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Funding</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status"><select className={input} value={f.fundingStatus} onChange={set('fundingStatus')}>{FUNDING_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Stage"><select className={input} value={f.fundingStage} onChange={set('fundingStage')}>{FUNDING_STAGES.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Amount"><input className={input} value={f.fundingAmount} onChange={set('fundingAmount')} placeholder="e.g. $3M" /></Field>
              <Field label="Date"><input className={input} value={f.fundingDate} onChange={set('fundingDate')} placeholder="e.g. May 2024" /></Field>
            </div>
            <Field label="Source URL" hint="Paste the article or filing that supports this. A company's own statement is not independent proof."><input className={input} value={f.fundingSourceUrl} onChange={set('fundingSourceUrl')} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.fundingVerified} onChange={set('fundingVerified')} /> I verified this against the source</label>
          </section>

          <ResearchPanel company={c} onCompany={serverChanged} />
        </div>

        <div className="flex items-center gap-3 border-t border-stone-200 px-5 py-3">
          <button disabled={saving} className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => window.confirm(`Delete ${c.name}${c.applicationCount ? ` and its ${c.applicationCount} application${c.applicationCount === 1 ? '' : 's'}` : ''}? This cannot be undone.`) && onDelete()} className="text-sm text-rose-700 hover:underline">Delete</button>
          <span role="status" className={`ml-auto text-sm ${msg.type === 'err' ? 'text-rose-700' : 'text-emerald-700'}`}>{msg.text}</span>
        </div>
      </form>
    </div>
  )
}
