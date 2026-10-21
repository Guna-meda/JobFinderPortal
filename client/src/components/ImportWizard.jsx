import { useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { errorsToCsv } from '../importCsv'

const STEPS = ['Upload', 'Map columns', 'Review', 'Done']
const btn = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50'
const primary = `${btn} bg-accent text-white hover:bg-accent/90`
const secondary = `${btn} border border-stone-300 bg-white hover:bg-stone-50`
const cell = 'px-3 py-1.5 align-top'

function Tile({ label, value, tone = '' }) {
  return (
    <div className="rounded-md border border-stone-200 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export default function ImportWizard({ onClose, onDone }) {
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [mapping, setMapping] = useState({})
  const [policy, setPolicy] = useState('skip')
  const [decisions, setDecisions] = useState({})
  const [plan, setPlan] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const input = useRef(null)

  const guard = async (label, fn) => {
    setBusy(label); setError('')
    try { return await fn() } catch (e) { setError(e.message); return null } finally { setBusy('') }
  }

  const pick = async (f) => {
    if (!f) return
    if (!/\.csv$/i.test(f.name)) { setError('Only .csv files are supported. Export your sheet as CSV first.'); return }
    const p = await guard('Reading file…', () => api.importPreview(f))
    if (!p) return
    setFile(f); setPreview(p); setMapping(p.suggestedMapping); setStep(1)
  }

  const runPlan = async (pol, dec, label = 'Checking rows…') => {
    const p = await guard(label, () => api.importRun(file, { mapping, policy: pol, decisions: dec, dryRun: true }))
    if (p) { setPlan(p); return true }
    return false
  }

  const problems = useMemo(() => {
    if (!preview) return []
    const out = []
    const used = {}
    for (const [h, t] of Object.entries(mapping)) {
      if (t === 'extra' || t === 'ignore') continue
      if (used[t]) out.push(`"${used[t]}" and "${h}" are both mapped to the same field.`)
      used[t] = h
    }
    if (!used.name) out.push('Choose which column holds the company name.')
    return out
  }, [mapping, preview])

  const toReview = async () => { if (await runPlan(policy, decisions)) setStep(2) }
  const changePolicy = (p) => { setPolicy(p); setDecisions({}); runPlan(p, {}) }
  const decide = (row, v) => { const d = { ...decisions, [row]: v }; setDecisions(d); runPlan(policy, d) }

  const commit = async () => {
    const r = await guard(`Importing ${preview.rowCount} rows…`, () => api.importRun(file, { mapping, policy, decisions, dryRun: false }))
    if (r) { setResult(r); setStep(3); onDone(r) }
  }

  const errCsv = (r) => download(errorsToCsv(preview.headers, r.failed.items), 'import-errors.csv')
  const s = (result || plan)?.summary

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="Import CSV">
      <div className="my-6 w-full max-w-4xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <ol className="flex gap-4 text-sm">
            {STEPS.map((n, i) => (
              <li key={n} className={i === step ? 'font-semibold text-ink' : 'text-stone-400'}>{i + 1}. {n}</li>
            ))}
          </ol>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none text-stone-400 hover:text-ink">×</button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
          {busy && <div role="status" className="text-sm text-stone-500">{busy}</div>}

          {step === 0 && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]) }}
              className="rounded-lg border-2 border-dashed border-stone-300 p-10 text-center"
            >
              <p className="font-medium">Choose a CSV file</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
                UTF-8 CSV, up to 10 MB / 20,000 rows. Nothing is saved until you confirm on the review step.
              </p>
              <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { pick(e.target.files[0]); e.target.value = '' }} />
              <button className={`${primary} mt-4`} disabled={!!busy} onClick={() => input.current.click()}>Select file</button>
            </div>
          )}

          {step === 1 && preview && (
            <>
              <p className="text-sm text-stone-600">
                <b>{preview.fileName}</b>: {preview.rowCount} rows{preview.blankRows ? ` (${preview.blankRows} blank rows ignored)` : ''}.
                Check how each column will be imported.
              </p>
              <div className="overflow-x-auto rounded-md border border-stone-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                    <tr><th className={cell}>CSV column</th><th className={cell}>Sample values</th><th className={cell}>Import as</th></tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {preview.headers.map((h) => (
                      <tr key={h}>
                        <td className={`${cell} font-medium`}>{h}</td>
                        <td className={`${cell} max-w-xs truncate text-stone-500`}>{preview.samples[h].join(' · ') || <span className="text-stone-300">empty</span>}</td>
                        <td className={cell}>
                          <select
                            aria-label={`Map column ${h}`}
                            value={mapping[h] ?? 'extra'}
                            onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm"
                          >
                            <optgroup label="Import as">
                              {preview.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                            </optgroup>
                            <optgroup label="Other">
                              <option value="extra">Keep as extra data</option>
                              <option value="ignore">Ignore this column</option>
                            </optgroup>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {problems.map((p) => <p key={p} role="alert" className="text-sm text-red-700">{p}</p>)}
              <div className="flex justify-between">
                <button className={secondary} onClick={() => setStep(0)}>Back</button>
                <button className={primary} disabled={!!busy || problems.length > 0} onClick={toReview}>Review import</button>
              </div>
            </>
          )}

          {step === 2 && plan && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Tile label="Will create" value={plan.summary.created} tone="text-emerald-700" />
                <Tile label="Will update" value={plan.summary.updated} />
                <Tile label="Will skip" value={plan.summary.skipped} />
                <Tile label="Failed rows" value={plan.summary.failed} tone={plan.summary.failed ? 'text-rose-700' : ''} />
                <Tile label="Possible duplicates" value={plan.summary.possibleDuplicates} />
              </div>

              <fieldset className="space-y-1 text-sm">
                <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">When a company already exists</legend>
                <label className="flex items-start gap-2"><input type="radio" name="policy" checked={policy === 'skip'} onChange={() => changePolicy('skip')} /> <span><b>Skip it</b>: leave the existing record exactly as it is.</span></label>
                <label className="flex items-start gap-2"><input type="radio" name="policy" checked={policy === 'update'} onChange={() => changePolicy('update')} /> <span><b>Update it</b>: fill empty fields and refresh location, industry and unverified funding. Notes, status, dates and verified data are never overwritten, and blank cells never erase anything.</span></label>
              </fieldset>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Sample of parsed rows</h3>
                <div className="overflow-x-auto rounded-md border border-stone-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-stone-50 text-stone-500"><tr>{['Row', 'Action', 'Company', 'Website', 'Location', 'Industry', 'Stage', 'Status'].map((h) => <th key={h} className={cell}>{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-stone-100">
                      {plan.sample.map((r) => (
                        <tr key={r.row}>
                          <td className={cell}>{r.row}</td><td className={`${cell} capitalize`}>{r.action}</td>
                          <td className={`${cell} font-medium`}>{r.doc.name}</td><td className={cell}>{r.doc.website || '–'}</td>
                          <td className={cell}>{r.doc.location || '–'}</td><td className={cell}>{r.doc.industry || '–'}</td>
                          <td className={cell}>{r.doc.fundingStage || '–'}</td><td className={cell}>{r.doc.appStatus || '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {plan.duplicates.total > 0 && (
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Possible duplicates ({plan.duplicates.total})</h3>
                  <div className="max-h-64 overflow-auto rounded-md border border-stone-200">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-stone-50 text-stone-500"><tr><th className={cell}>Row</th><th className={cell}>Company</th><th className={cell}>Why it was flagged</th><th className={cell}>Action</th></tr></thead>
                      <tbody className="divide-y divide-stone-100">
                        {plan.duplicates.items.map((d) => (
                          <tr key={d.row}>
                            <td className={cell}>{d.row}</td><td className={`${cell} font-medium`}>{d.name}</td><td className={cell}>{d.reason}</td>
                            <td className={cell}>
                              <select aria-label={`Action for row ${d.row}`} value={d.action} onChange={(e) => decide(d.row, e.target.value)} className="rounded border border-stone-300 bg-white px-1.5 py-1">
                                <option value="skip">Skip</option><option value="update">Update existing</option><option value="create">Create new</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {plan.duplicates.truncated && <p className="mt-1 text-xs text-stone-500">Showing the first {plan.duplicates.items.length}. The policy above applies to the rest.</p>}
                </section>
              )}

              {plan.failed.total > 0 && (
                <section>
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-rose-700">Rows that cannot be imported ({plan.failed.total})</h3>
                    <button className="text-xs text-accent underline" onClick={() => errCsv(plan)}>Download error CSV</button>
                  </div>
                  <ul className="max-h-40 space-y-0.5 overflow-auto rounded-md border border-rose-100 bg-rose-50/50 p-2 text-xs">
                    {plan.failed.items.slice(0, 50).map((f) => <li key={f.row}>Row {f.row}: {f.error}</li>)}
                  </ul>
                </section>
              )}

              {plan.warnings.total > 0 && (
                <details className="text-xs text-stone-600">
                  <summary className="cursor-pointer">{plan.warnings.total} value warnings (values kept as extra data, not lost)</summary>
                  <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-4">
                    {plan.warnings.items.slice(0, 100).map((w, i) => <li key={i}>Row {w.row}: {w.message}</li>)}
                  </ul>
                </details>
              )}

              <div className="rounded-md bg-stone-50 p-3 text-sm">
                This will create <b>{plan.summary.created}</b>, update <b>{plan.summary.updated}</b> and skip <b>{plan.summary.skipped}</b> companies.
                {plan.summary.failed > 0 && <> <b>{plan.summary.failed}</b> failed rows will not be imported.</>} Existing filters and application data stay intact.
              </div>
              <div className="flex justify-between">
                <button className={secondary} onClick={() => setStep(1)}>Back</button>
                <button className={primary} disabled={!!busy || plan.summary.created + plan.summary.updated === 0} onClick={commit}>
                  {plan.summary.created + plan.summary.updated === 0 ? 'Nothing to import' : 'Import now'}
                </button>
              </div>
            </>
          )}

          {step === 3 && result && (
            <>
              <h2 className="font-medium">Import finished</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Tile label="Created" value={s.created} tone="text-emerald-700" />
                <Tile label="Updated" value={s.updated} />
                <Tile label="Skipped" value={s.skipped} />
                <Tile label="Failed" value={s.failed} tone={s.failed ? 'text-rose-700' : ''} />
                <Tile label="Possible duplicates" value={s.possibleDuplicates} />
              </div>
              {s.failed > 0 && <button className={secondary} onClick={() => errCsv(result)}>Download error CSV ({s.failed} rows)</button>}
              <div className="flex justify-end"><button className={primary} onClick={onClose}>Close</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
