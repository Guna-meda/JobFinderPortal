import { useCallback, useEffect, useState } from 'react'
import { api, STATUSES, FUNDING_STATUSES, FUNDING_STAGES } from './api'
import Stats from './components/Stats'
import CompanyTable from './components/CompanyTable'
import EditDrawer from './components/EditDrawer'
import ImportButton from './components/ImportButton'

const EMPTY = { q: '', fundingStatus: '', fundingStage: '', location: '', industry: '', hasRelevantRoles: '', appStatus: '', researchStatus: '', sort: 'name' }

const sel = 'rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-accent/40'

function Select({ value, onChange, label, options }) {
  return (
    <select aria-label={label} className={sel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
      ))}
    </select>
  )
}

export default function App() {
  const [filters, setFilters] = useState(EMPTY)
  const [debounced, setDebounced] = useState(EMPTY)
  const [data, setData] = useState({ items: [], total: 0 })
  const [facets, setFacets] = useState({ locations: [], industries: [] })
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 250)
    return () => clearTimeout(t)
  }, [filters])

  const refresh = useCallback(async () => {
    try {
      const [list, s, f] = await Promise.all([api.list(debounced), api.stats(), api.facets()])
      setData(list); setStats(s); setFacets(f); setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [debounced])

  useEffect(() => { refresh() }, [refresh])

  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }))
  const dirty = Object.entries(filters).some(([k, v]) => k !== 'sort' && v)
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const patch = async (id, p) => {
    try {
      const updated = await api.update(id, p)
      setData((d) => ({ ...d, items: d.items.map((c) => (c._id === id ? updated : c)) }))
      setSelected((s) => (s && s._id === id ? updated : s))
      api.stats().then(setStats)
      return updated
    } catch (e) { flash(e.message); throw e }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Startup Finder</h1>
            <p className="text-xs text-stone-500">Discovery and application tracker</p>
          </div>
          <div className="flex items-center gap-2">
            <a href={api.exportUrl({ ...debounced })} className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50">
              Export CSV{dirty ? ' (filtered)' : ''}
            </a>
            <ImportButton onDone={(r) => { flash(`Imported ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} bad rows` : ''}.`); refresh() }} onError={flash} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
        <Stats stats={stats} />

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search" placeholder="Search name, domain, notes…" value={filters.q}
            onChange={(e) => set('q')(e.target.value)}
            className={`${sel} w-64`}
          />
          <Select label="Funding" value={filters.fundingStatus} onChange={set('fundingStatus')} options={FUNDING_STATUSES} />
          <Select label="Stage" value={filters.fundingStage} onChange={set('fundingStage')} options={FUNDING_STAGES} />
          <Select label="Location" value={filters.location} onChange={set('location')} options={facets.locations} />
          <Select label="Industry" value={filters.industry} onChange={set('industry')} options={facets.industries} />
          <Select label="Eng roles" value={filters.hasRelevantRoles} onChange={set('hasRelevantRoles')} options={[{ value: 'yes', label: 'Has engineering roles' }, { value: 'unknown', label: 'Unknown' }, { value: 'no', label: 'No roles' }]} />
          <Select label="Status" value={filters.appStatus} onChange={set('appStatus')} options={STATUSES} />
          <Select label="Research" value={filters.researchStatus} onChange={set('researchStatus')} options={[{ value: 'not_researched', label: 'Not researched' }, { value: 'researched', label: 'Researched' }, { value: 'partial', label: 'Partial' }, { value: 'failed', label: 'Failed' }]} />
          <select aria-label="Sort" className={sel} value={filters.sort} onChange={(e) => set('sort')(e.target.value)}>
            <option value="name">Sort: Name</option>
            <option value="recent">Sort: Recently updated</option>
            <option value="followUp">Sort: Follow-up date</option>
            <option value="status">Sort: Status</option>
          </select>
          {dirty && <button onClick={() => setFilters(EMPTY)} className="text-sm text-accent underline">Clear</button>}
          <span className="ml-auto text-sm text-stone-500">{data.total} {data.total === 1 ? 'company' : 'companies'}</span>
        </div>

        {loading ? (
          <div className="rounded-lg border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">Loading…</div>
        ) : data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-12 text-center">
            {stats?.total === 0 ? (
              <>
                <h2 className="font-medium">No companies yet</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
                  Export your Google Sheet as CSV (File → Download → CSV) and import it. A <code>Company Name</code> column is required;
                  Website, Location, Industry, Funding Stage and Notes are picked up automatically.
                </p>
              </>
            ) : (
              <>
                <h2 className="font-medium">No companies match these filters</h2>
                <button onClick={() => setFilters(EMPTY)} className="mt-2 text-sm text-accent underline">Clear filters</button>
              </>
            )}
          </div>
        ) : (
          <CompanyTable items={data.items} onOpen={setSelected} onStatus={(c, appStatus) => patch(c._id, { appStatus, ...(appStatus === 'Applied' && !c.appliedDate ? { appliedDate: new Date().toISOString().slice(0, 10) } : {}) })} />
        )}
      </main>

      {selected && (
        <EditDrawer
          key={selected._id}
          company={selected}
          onClose={() => setSelected(null)}
          onSave={(p) => patch(selected._id, p)}
          onResearch={async () => {
            const c = await api.research(selected._id)
            setData((d) => ({ ...d, items: d.items.map((x) => (x._id === c._id ? c : x)) }))
            setSelected(c); refresh()
            return c
          }}
          onDelete={async () => { await api.remove(selected._id); setSelected(null); refresh() }}
        />
      )}

      {toast && <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-md bg-ink px-4 py-2 text-sm text-white shadow-lg">{toast}</div>}
    </div>
  )
}
