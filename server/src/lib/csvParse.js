import { parse } from 'csv-parse/sync';

export const MAX_ROWS = 20000;

/** Thrown for any problem with the uploaded file itself. Mapped to HTTP 400; nothing is written. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function decodeUtf8(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ImportError(
      'The file is not valid UTF-8 text. In Google Sheets use File > Download > CSV; in Excel choose "CSV UTF-8".'
    );
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) throw new ImportError('The file looks binary, not a CSV.');
  return text;
}

// Pick the delimiter from the header line (handles semicolon/tab exports from some Excel locales).
function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function dedupeHeaders(cells) {
  const seen = new Map();
  return cells.map((raw, i) => {
    let h = String(raw ?? '').trim() || `Column ${i + 1}`;
    // Names like __proto__ would collide with object internals and lose their values.
    if (['__proto__', 'constructor', 'prototype'].includes(h.toLowerCase())) h = `${h}_`;
    const n = (seen.get(h.toLowerCase()) || 0) + 1;
    seen.set(h.toLowerCase(), n);
    if (n > 1) h = `${h} (${n})`;
    return h;
  });
}

/**
 * Parse CSV bytes into { headers, records, delimiter, blankRows }.
 * records: [{ row, values: {header: string}, overflow: string[] }], row = record number (header is row 1).
 * Throws ImportError on anything malformed, so a bad file can never be partially applied.
 */
export function parseCsv(buf) {
  const text = decodeUtf8(buf);
  if (!text.trim()) throw new ImportError('The file is empty.');
  const delimiter = sniffDelimiter(text);
  let rows;
  try {
    rows = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    throw new ImportError(`Malformed CSV: ${e.message}. Nothing was imported.`);
  }
  if (rows.length < 2) throw new ImportError('The file needs a header row and at least one data row.');
  if (rows[0].every((c) => !String(c).trim())) throw new ImportError('The header row is empty.');
  if (rows.length - 1 > MAX_ROWS) throw new ImportError(`Too many rows (${rows.length - 1}). The limit is ${MAX_ROWS} per import.`);

  const headers = dedupeHeaders(rows[0]);
  const records = [];
  let blankRows = 0;
  rows.slice(1).forEach((cells, i) => {
    if (cells.every((c) => !String(c).trim())) {
      blankRows++;
      return;
    }
    const values = {};
    headers.forEach((h, j) => {
      values[h] = cells[j] ?? '';
    });
    records.push({ row: i + 2, values, overflow: cells.slice(headers.length) });
  });
  if (!records.length) throw new ImportError('The file has no data rows (all rows are blank).');
  return { headers, records, delimiter, blankRows };
}
