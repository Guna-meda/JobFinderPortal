// Shared helpers for showing application status and follow-up urgency. Days are compared in UTC,
// matching how the server stores and checks follow-up dates.
export const statusTone = {
  'Not Applied': 'bg-stone-100 text-stone-600',
  'To Apply': 'bg-amber-50 text-amber-800',
  Applied: 'bg-sky-50 text-sky-800',
  Replied: 'bg-teal-50 text-teal-800',
  Interview: 'bg-emerald-100 text-emerald-900',
  Rejected: 'bg-rose-50 text-rose-800',
  Offer: 'bg-emerald-600 text-white',
}

export const TERMINAL = ['Rejected', 'Offer']
const DAY = 86_400_000
const dayStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

/** Whole days from today until the follow-up date (negative = overdue). */
export function daysUntil(date, now = new Date()) {
  return Math.round((dayStart(new Date(date)) - dayStart(now)) / DAY)
}

/** { text, tone } describing a follow-up date, or null if none / finished. */
export function followUpLabel({ followUpDate, status }, now = new Date()) {
  if (!followUpDate || TERMINAL.includes(status)) return null
  const n = daysUntil(followUpDate, now)
  if (n < 0) return { text: `Follow-up overdue ${-n}d`, tone: 'bg-rose-100 text-rose-800', overdue: true }
  if (n === 0) return { text: 'Follow up today', tone: 'bg-amber-100 text-amber-900', overdue: false }
  return { text: `Follow-up in ${n}d`, tone: 'bg-stone-100 text-stone-600', overdue: false }
}
