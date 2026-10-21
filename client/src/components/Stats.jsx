export default function Stats({ stats }) {
  const items = [
    ['Companies', stats?.total],
    ['Researched', stats?.researched],
    ['Applications sent', stats?.applied],
    ['Replies', stats?.replies],
    ['Interviews', stats?.interviews],
  ]
  return (
    <dl className="grid grid-cols-2 divide-x divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white sm:grid-cols-5">
      {items.map(([label, value]) => (
        <div key={label} className="px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
          <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value ?? '–'}</dd>
        </div>
      ))}
    </dl>
  )
}
