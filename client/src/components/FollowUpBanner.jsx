import { useEffect, useState } from 'react'
import { api } from '../api'
import { followUpLabel } from '../tracking'

// Lists the follow-ups that are due or overdue (finished applications never appear here).
export default function FollowUpBanner({ stats, onOpenCompany, refreshKey }) {
  const [items, setItems] = useState([])
  const due = stats?.followUpsDue || 0

  useEffect(() => {
    if (!due) return undefined
    let alive = true
    api.followUps(5).then((r) => alive && setItems(r.items)).catch(() => alive && setItems([]))
    return () => { alive = false }
  }, [due, refreshKey])

  if (!due) return null
  const overdue = stats.followUpsOverdue || 0
  return (
    <section aria-label="Follow-ups due" className={`rounded-lg border px-4 py-3 ${overdue ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}>
      <h2 className={`text-sm font-semibold ${overdue ? 'text-rose-900' : 'text-amber-900'}`}>
        {due} follow-up{due === 1 ? '' : 's'} due{overdue ? ` (${overdue} overdue)` : ' today'}
      </h2>
      <ul className="mt-1 space-y-0.5 text-sm">
        {items.map((a) => {
          const fu = followUpLabel(a)
          return (
            <li key={a._id}>
              <button onClick={() => onOpenCompany(a.company)} className="text-left text-ink hover:underline">
                <b>{a.companyName}</b>{a.role ? ` · ${a.role}` : ''}{a.nextAction ? ` — ${a.nextAction}` : ''}
              </button>
              {fu && <span className="ml-2 text-xs text-stone-600">{fu.text}</span>}
            </li>
          )
        })}
      </ul>
      {due > items.length && items.length > 0 && <p className="mt-1 text-xs text-stone-600">…and {due - items.length} more. Use the Follow-up due filter to see their companies.</p>}
    </section>
  )
}
