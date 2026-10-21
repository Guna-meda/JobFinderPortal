import { useState } from 'react'
import ImportWizard from './ImportWizard'

export default function ImportButton({ onDone }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90">
        Import CSV
      </button>
      {open && <ImportWizard onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  )
}
