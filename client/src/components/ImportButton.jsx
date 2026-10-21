import { useRef, useState } from 'react'
import { api } from '../api'

export default function ImportButton({ onDone, onError }) {
  const ref = useRef(null)
  const [busy, setBusy] = useState(false)

  const pick = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      onDone(await api.importCsv(file))
    } catch (err) {
      onError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input ref={ref} type="file" accept=".csv,text/csv" hidden onChange={pick} />
      <button
        onClick={() => ref.current.click()} disabled={busy}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
      >
        {busy ? 'Importing…' : 'Import CSV'}
      </button>
    </>
  )
}
