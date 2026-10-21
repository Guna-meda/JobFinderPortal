import { useState } from 'react'
import { STATUSES, FUNDING_STATUSES, FUNDING_STAGES } from '../api'
import { fmtDate } from './CompanyTable'

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
  fundingStatus: c.fundingStatus, fundingStage: c.fundingStage, fundingSourceUrl: c.fundingSourceUrl || '', fundingVerified: !!c.fundingVerified,
  careersUrl: c.careersUrl || '', contactEmail: c.contactEmail || '', contactName: c.contactName || '',
  hasRelevantRoles: c.hasRelevantRoles, appStatus: c.appStatus,
  appliedDate: fmtDate(c.appliedDate), followUpDate: fmtDate(c.followUpDate), notes: c.notes || '',
})

export default function EditDrawer({ company: c, onClose, onSave, onResearch, onDelete }) {
  const [f, setF] = useState(() => initial(c))
  const [saving, setSaving] = useState(false)
  const [researching, setResearching] = useState(false)
  const [msg, setMsg] = useState({ type: '', text: '' })
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const save = async (e) => {
    e.preventDefault()
    setSaving(true); setMsg({ type: '', text: '' })
    try {
      await onSave(f)
      setMsg({ type: 'ok', text: 'Saved.' })
    } catch (err) { setMsg({ type: 'err', text: err.message }) } finally { setSaving(false) }
  }

  const research = async () => {
    setResearching(true); setMsg({ type: '', text: '' })
    try {
      const r = await onResearch()
      setF((x) => ({ ...x, careersUrl: r.careersUrl || '', contactEmail: r.contactEmail || '', hasRelevantRoles: r.hasRelevantRoles }))
      setMsg({ type: 'ok', text: 'Research finished. Review the findings below.' })
    } catch (err) { setMsg({ type: 'err', text: err.message }) } finally { setResearching(false) }
  }

  // After research, reflect server-found values in the form unless the user edited them.
  const found = (label, value, src) => value ? (
    <p className="text-xs text-stone-600">{label}: <span className="font-medium">{value}</span>{src && <> · source <a className="text-accent underline" href={src} target="_blank" rel="noreferrer">{new URL(src).hostname}</a></>}</p>
  ) : null

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/30" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{c.name}</h2>
            <p className="text-xs text-stone-500">Edit details, track your application</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-xl leading-none text-stone-400 hover:text-ink">×</button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Application</h3>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Status"><select className={input} value={f.appStatus} onChange={set('appStatus')}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Applied on"><input type="date" className={input} value={f.appliedDate} onChange={set('appliedDate')} /></Field>
              <Field label="Follow up"><input type="date" className={input} value={f.followUpDate} onChange={set('followUpDate')} /></Field>
            </div>
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
            <Field label="Careers URL"><input className={input} value={f.careersUrl} onChange={set('careersUrl')} /></Field>
            <Field label="Engineering roles">
              <select className={input} value={f.hasRelevantRoles} onChange={set('hasRelevantRoles')}>
                <option value="unknown">Unknown</option><option value="yes">Has relevant roles</option><option value="no">No relevant roles</option>
              </select>
            </Field>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Funding (manual)</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status"><select className={input} value={f.fundingStatus} onChange={set('fundingStatus')}>{FUNDING_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Stage"><select className={input} value={f.fundingStage} onChange={set('fundingStage')}>{FUNDING_STAGES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            </div>
            <Field label="Source URL" hint="Paste the article or filing that supports this."><input className={input} value={f.fundingSourceUrl} onChange={set('fundingSourceUrl')} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.fundingVerified} onChange={set('fundingVerified')} /> I verified this against the source</label>
          </section>

          <section className="space-y-2 rounded-md bg-stone-50 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Website research</h3>
              <button type="button" onClick={research} disabled={researching || !c.website} className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-stone-50 disabled:opacity-50">
                {researching ? 'Checking site…' : c.researchedAt ? 'Re-run research' : 'Run research'}
              </button>
            </div>
            {!c.website && <p className="text-xs text-stone-500">Add a website to enable research.</p>}
            <p className="text-xs text-stone-500">Fetches at most 4 public pages, honours robots.txt. Results come from the site itself and must be double-checked. Funding is never inferred.</p>
            {c.researchedAt && <p className="text-xs text-stone-600">Status: <b>{c.researchStatus}</b> · {new Date(c.researchedAt).toLocaleString()}</p>}
            {found('Careers page', c.careersVerified && c.careersUrl, c.careersSourceUrl)}
            {found('Public email', c.contactEmailSourceUrl && c.contactEmail, c.contactEmailSourceUrl)}
            {c.openRoles?.length > 0 && (
              <ul className="list-disc pl-4 text-xs">
                {c.openRoles.map((r) => <li key={r.url}><a className="text-accent underline" href={r.url} target="_blank" rel="noreferrer">{r.title}</a></li>)}
              </ul>
            )}
            {c.researchLog?.length > 0 && (
              <details className="text-xs text-stone-500"><summary className="cursor-pointer">Log</summary><ul className="mt-1 list-disc pl-4">{c.researchLog.map((l, i) => <li key={i}>{l}</li>)}</ul></details>
            )}
          </section>
        </div>

        <div className="flex items-center gap-3 border-t border-stone-200 px-5 py-3">
          <button disabled={saving} className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => window.confirm(`Delete ${c.name}?`) && onDelete()} className="text-sm text-rose-700 hover:underline">Delete</button>
          <span role="status" className={`ml-auto text-sm ${msg.type === 'err' ? 'text-rose-700' : 'text-emerald-700'}`}>{msg.text}</span>
        </div>
      </form>
    </div>
  )
}
