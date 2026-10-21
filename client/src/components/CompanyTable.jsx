import { STATUSES } from '../api'

const statusTone = {
  'Not Applied': 'bg-stone-100 text-stone-600',
  'To Apply': 'bg-amber-50 text-amber-800',
  Applied: 'bg-sky-50 text-sky-800',
  Replied: 'bg-teal-50 text-teal-800',
  Interview: 'bg-emerald-100 text-emerald-900',
  Rejected: 'bg-rose-50 text-rose-800',
  Offer: 'bg-emerald-600 text-white',
}

export const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')

function Verified({ ok, label }) {
  return ok ? <span title={`${label}: found by research, source recorded`} className="text-emerald-700">✓</span> : null
}

export default function CompanyTable({ items, onOpen, onStatus }) {
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
          <tr>
            {['Company', 'Location', 'Industry', 'Funding', 'Careers / contact', 'Status', 'Follow-up'].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {items.map((c) => {
            const overdue = c.followUpDate && fmtDate(c.followUpDate) <= today && ['Applied', 'Replied', 'Interview'].includes(c.appStatus)
            return (
              <tr key={c._id} className="hover:bg-stone-50/70">
                <td className="px-3 py-2">
                  <button onClick={() => onOpen(c)} className="text-left font-medium text-ink hover:text-accent hover:underline">{c.name}</button>
                  {c.website && <div className="text-xs text-stone-500">{c.domain}</div>}
                </td>
                <td className="px-3 py-2 text-stone-600">{c.location || '–'}</td>
                <td className="px-3 py-2 text-stone-600">{c.industry || '–'}</td>
                <td className="px-3 py-2 text-stone-600">
                  {c.fundingStatus === 'unknown' && c.fundingStage === 'unknown' ? <span className="text-stone-400">Unknown</span> : (
                    <>
                      <span className="capitalize">{c.fundingStatus !== 'unknown' ? c.fundingStatus : ''}</span>
                      {c.fundingStage !== 'unknown' && <span className="ml-1 rounded bg-stone-100 px-1.5 py-0.5 text-xs">{c.fundingStage}</span>}
                    </>
                  )}
                  {!c.fundingVerified && (c.fundingStatus !== 'unknown' || c.fundingStage !== 'unknown') && <span title="Unverified: from your sheet, no source URL checked" className="ml-1 text-xs text-stone-400">(unverified)</span>}
                </td>
                <td className="space-x-2 px-3 py-2 text-xs">
                  {c.careersUrl ? <a href={c.careersUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Careers<Verified ok={c.careersVerified} label="Careers" /></a> : <span className="text-stone-400">no careers</span>}
                  {c.contactEmail ? <a href={`mailto:${c.contactEmail}`} className="text-accent hover:underline">{c.contactEmail}</a> : <span className="text-stone-400">no email</span>}
                  {c.hasRelevantRoles === 'yes' && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">eng roles</span>}
                </td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Status for ${c.name}`} value={c.appStatus}
                    onChange={(e) => onStatus(c, e.target.value).catch(() => {})}
                    className={`rounded-full border-0 px-2 py-1 text-xs font-medium ${statusTone[c.appStatus]}`}
                  >
                    {STATUSES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </td>
                <td className={`px-3 py-2 text-xs tabular-nums ${overdue ? 'font-medium text-rose-700' : 'text-stone-600'}`}>{fmtDate(c.followUpDate) || '–'}{overdue && ' • due'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
