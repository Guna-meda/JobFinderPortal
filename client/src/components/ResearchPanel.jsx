import { useEffect, useState } from 'react'
import { api } from '../api'

const KINDS = [
  ['website', 'Website'],
  ['careers', 'Careers page'],
  ['email', 'Public email'],
  ['role', 'Role leads'],
  ['funding', 'Funding statements'],
]
const OUTCOME = {
  researched: 'Evidence found',
  partial: 'Some pages could not be read',
  not_found: 'Nothing detected on the pages read',
  failed: 'Failed',
}
const NOT_FOUND_TEXT = {
  careers: "No careers link was detected on the pages read. That doesn't mean they aren't hiring.",
  email: "No public role-style email (careers@, jobs@, hello@…) was detected. That doesn't mean one doesn't exist.",
  roles: 'The careers page was read but no role links matched the keywords. Listings loaded by JavaScript are not read.',
}
const CONF = {
  verified: ['verified', 'bg-emerald-50 text-emerald-800', 'Seen directly on an official-site page'],
  inferred: ['inferred', 'bg-amber-50 text-amber-800', 'A keyword or link lead, not confirmed'],
  unverified: ['unverified', 'bg-stone-100 text-stone-600', 'Weak evidence or the company’s own claim'],
}
const btn = 'rounded border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-stone-50 disabled:opacity-50'
const isHttp = (u) => /^https?:\/\//i.test(u || '')
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')
const ageDays = (d) => (d ? (Date.now() - new Date(d).getTime()) / 86_400_000 : 0)

function SourceLink({ url }) {
  if (!isHttp(url)) return <span>{url}</span>
  let label = url
  try { const u = new URL(url); label = u.hostname + (u.pathname === '/' ? '' : u.pathname) } catch { /* keep raw */ }
  return <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{label} ↗</a>
}

function Finding({ f, staleDays, busy, onDecide, onRestore }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(f.kind === 'role' ? f.title : f.value)
  const [conflict, setConflict] = useState(null)
  const editable = f.kind !== 'funding'
  const [label, tone, hint] = CONF[f.confidence]
  const stale = ageDays(f.observedAt) > staleDays
  const unseen = f.seenInLatestRun === false

  const accept = async (overwrite = false) => {
    const err = await onDecide(f, { action: 'accept', ...(editing ? { value } : {}), overwrite })
    if (err?.status === 409) setConflict(err.data.conflict)
    else if (!err) { setConflict(null); setEditing(false) }
  }

  return (
    <li className="space-y-1 rounded-md border border-stone-200 bg-white p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-sm">
          {f.kind === 'role' && <div className="font-medium">{f.title}</div>}
          {f.kind === 'funding' ? (
            <blockquote className="border-l-2 border-stone-300 pl-2 text-stone-700">“{f.value}”</blockquote>
          ) : isHttp(f.value) ? (
            <a href={f.value} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline">{f.value} ↗</a>
          ) : (
            <span className="break-all font-medium">{f.value}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span title={hint} className={`rounded px-1.5 py-0.5 font-medium ${tone}`}>{label}</span>
          {stale && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700" title={`Observed more than ${staleDays} days ago`}>stale</span>}
          {unseen && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700" title="Not seen in the latest completed run">not re-observed</span>}
        </div>
      </div>
      <p className="text-xs text-stone-500">
        Source: <SourceLink url={f.sourceUrl} /> · observed {day(f.observedAt)} · {f.basis.replace(/-/g, ' ')}
      </p>
      {f.evidence && <p className="text-xs text-stone-600">{f.evidence}</p>}
      {f.kind === 'funding' && <p className="text-xs text-stone-500">{[f.meta?.stage && `stage: ${f.meta.stage}`, f.meta?.amount && `amount: ${f.meta.amount}`, f.meta?.date && `date: ${f.meta.date}`].filter(Boolean).join(' · ') || 'No stage, amount or date stated in the sentence.'}</p>}

      {f.status === 'pending' && (
        <>
          {editing && <input aria-label="Edit value" value={value} onChange={(e) => setValue(e.target.value)} className="w-full rounded border border-stone-300 px-2 py-1 text-sm" />}
          {conflict && (
            <div role="alert" className="rounded bg-amber-50 p-2 text-xs text-amber-900">
              This would replace the current {conflict.field}: <b className="break-all">{String(conflict.current)}</b>. Your existing value is kept unless you confirm.
              <div className="mt-1 flex gap-2">
                <button className={btn} disabled={busy} onClick={() => accept(true)}>Replace it</button>
                <button className={btn} onClick={() => setConflict(null)}>Keep mine</button>
              </div>
            </div>
          )}
          <div className="flex gap-1.5 pt-0.5">
            <button className={btn} disabled={busy} onClick={() => accept(false)}>{editing ? 'Accept edited' : 'Accept'}</button>
            {editable && <button className={btn} onClick={() => setEditing((e) => !e)}>{editing ? 'Cancel edit' : 'Edit'}</button>}
            <button className={btn} disabled={busy} onClick={() => onDecide(f, { action: 'reject' })}>Reject</button>
          </div>
        </>
      )}
      {f.status === 'accepted' && <p className="text-xs font-medium text-emerald-700">✓ Applied to this company</p>}
      {f.status === 'rejected' && <button className={btn} disabled={busy} onClick={() => onRestore(f)}>Restore</button>}
    </li>
  )
}

export default function ResearchPanel({ company: c, onCompany }) {
  const [cfg, setCfg] = useState({ staleDays: 90, roleKeywords: [], maxPages: 6 })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showRejected, setShowRejected] = useState(false)

  useEffect(() => { api.researchConfig().then(setCfg).catch(() => {}) }, [])

  const running = c.researchStatus === 'running'
  const err = c.researchError
  const findings = c.findings || []
  const pending = findings.filter((f) => f.status !== 'rejected')
  const rejected = findings.filter((f) => f.status === 'rejected')
  const stale = c.researchedAt && ageDays(c.researchedAt) > cfg.staleDays

  const start = async () => {
    setBusy(true); setMsg('')
    try { onCompany(await api.research(c._id)) } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  // Returns the error (so a finding can show a conflict prompt) or null on success.
  const decide = async (f, body) => {
    setBusy(true); setMsg('')
    try { onCompany(await api.decideFinding(c._id, f._id, body)); return null } catch (e) {
      if (e.status !== 409) setMsg(e.message)
      return e
    } finally { setBusy(false) }
  }
  const decideMany = async (ids, action) => {
    setBusy(true); setMsg('')
    try {
      const r = await api.decideFindings(c._id, { action, ids })
      onCompany(r.company)
      if (r.skipped.length) setMsg(`${r.skipped.length} could not be applied: ${[...new Set(r.skipped.map((s) => s.reason))].join('; ')}`)
    } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  const label = running ? 'Researching…' : err?.retryable ? 'Retry' : c.researchedAt ? 'Re-run research' : 'Run research'

  return (
    <section className="space-y-3 rounded-md bg-stone-50 p-3" aria-label="Website research">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Website research</h3>
        <button type="button" onClick={start} disabled={busy || running || !c.website} className={btn}>{label}</button>
      </div>
      {!c.website && <p className="text-xs text-stone-500">Add a website to enable research.</p>}
      <p className="text-xs text-stone-500">
        Reads up to {cfg.maxPages} public pages of the company’s own site, honours robots.txt, and never logs in or runs scripts. Nothing changes
        on this company until you accept a finding. Findings are leads: confirm them at the source before relying on them.
      </p>

      {running && <p role="status" className="text-xs text-stone-700"><span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />{c.researchProgress || 'Working…'}</p>}

      {!running && err && (
        <div role="alert" className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
          {err.message} {err.retryable ? 'This looks temporary: use Retry later.' : 'Check the website URL or the site’s access rules before retrying.'}
        </div>
      )}

      {c.researchedAt && !running && (
        <p className="text-xs text-stone-600">
          Last researched {day(c.researchedAt)} ({Math.floor(ageDays(c.researchedAt))} days ago) · {OUTCOME[c.researchStatus] || c.researchStatus}
          {c.researchPages ? ` · ${c.researchPages} page${c.researchPages === 1 ? '' : 's'} read` : ''}
          {stale && <span className="ml-1 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">stale: consider re-running</span>}
        </p>
      )}

      {!running && (c.researchNotFound || []).length > 0 && (
        <ul className="space-y-0.5 text-xs text-stone-500">
          {c.researchNotFound.map((k) => <li key={k}>• {NOT_FOUND_TEXT[k]}{k === 'roles' && cfg.roleKeywords.length ? ` Keywords: ${cfg.roleKeywords.join(', ')}.` : ''}</li>)}
        </ul>
      )}

      {msg && <p role="alert" className="text-xs text-rose-700">{msg}</p>}

      {KINDS.map(([kind, title]) => {
        const items = pending.filter((f) => f.kind === kind)
        if (!items.length) return null
        const open = items.filter((f) => f.status === 'pending')
        return (
          <div key={kind} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-stone-700">{title} ({items.length})</h4>
              {kind === 'role' && open.length > 1 && (
                <span className="flex gap-1.5">
                  <button className={btn} disabled={busy} onClick={() => decideMany(open.map((f) => f._id), 'accept')}>Accept all</button>
                  <button className={btn} disabled={busy} onClick={() => decideMany(open.map((f) => f._id), 'reject')}>Reject all</button>
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {items.map((f) => (
                <Finding key={f._id} f={f} staleDays={cfg.staleDays} busy={busy} onDecide={decide} onRestore={(x) => decide(x, { action: 'reset' })} />
              ))}
            </ul>
          </div>
        )
      })}

      {rejected.length > 0 && (
        <div>
          <button type="button" className="text-xs text-accent underline" onClick={() => setShowRejected((s) => !s)}>
            {showRejected ? 'Hide' : 'Show'} rejected ({rejected.length})
          </button>
          {showRejected && (
            <ul className="mt-1.5 space-y-1.5">
              {rejected.map((f) => <Finding key={f._id} f={f} staleDays={cfg.staleDays} busy={busy} onDecide={decide} onRestore={(x) => decide(x, { action: 'reset' })} />)}
            </ul>
          )}
        </div>
      )}

      {(c.researchLog || []).length > 0 && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer">Run log</summary>
          <ul className="mt-1 list-disc pl-4">{c.researchLog.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
