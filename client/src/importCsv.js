// Builds the downloadable "error CSV": the original columns of each failed row plus Row and Error.
const guard = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
const quote = (v) => {
  const s = guard(String(v ?? ''))
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function errorsToCsv(headers, failed) {
  const lines = [[...headers, 'Row', 'Error'].map(quote).join(',')]
  for (const f of failed) {
    lines.push([...headers.map((h) => f.data?.[h] ?? ''), f.row, f.error].map(quote).join(','))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}
