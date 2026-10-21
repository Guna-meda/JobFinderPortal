import Company from '../models/Company.js';
import { buildFilter, sortFor } from '../lib/filters.js';
import { parseCsv, ImportError } from '../lib/csvParse.js';
import { FIELDS, suggestMapping, validateMapping, planImport } from '../lib/importer.js';
import { buildCsv } from '../lib/exportCsv.js';

const CAPS = { duplicates: 1000, warnings: 1000, skipped: 1000, failed: 5000 };
const BATCH = 1000;

const bad = (msg) => new ImportError(msg);

function readFile(req) {
  if (!req.file) throw bad('Attach a CSV file in the "file" field.');
  if (!/\.csv$/i.test(req.file.originalname || '')) {
    throw bad('Only .csv files are supported. In Excel or Sheets, export the sheet as CSV first.');
  }
  return parseCsv(req.file.buffer);
}

function jsonField(req, name, fallback) {
  if (req.body?.[name] == null || req.body[name] === '') return fallback;
  try {
    return JSON.parse(req.body[name]);
  } catch {
    throw bad(`Field "${name}" is not valid JSON.`);
  }
}

const cap = (list, n) => ({ items: list.slice(0, n), total: list.length, truncated: list.length > n });

/** Strip the heavy/internal parts of a plan so it is safe and small enough to send to the browser. */
function publicPlan(plan, extra = {}) {
  const dup = cap(plan.duplicates, CAPS.duplicates);
  const skipped = cap(plan.skipped, CAPS.skipped);
  const failed = cap(plan.failed, CAPS.failed);
  const warnings = cap(plan.warnings, CAPS.warnings);
  return {
    ...extra,
    summary: {
      created: plan.created,
      updated: plan.updated,
      skipped: plan.skipped.length,
      failed: plan.failed.length,
      possibleDuplicates: plan.duplicates.length,
      warnings: plan.warnings.length,
    },
    duplicates: dup,
    skipped,
    failed,
    warnings,
    sample: plan.sample,
  };
}

export function registerImportExport(app, { upload, wrap }) {
  // Step 1: parse the file and suggest a column mapping. Writes nothing.
  app.post('/api/import/preview', upload.single('file'), wrap(async (req, res) => {
    const { headers, records, delimiter, blankRows } = readFile(req);
    const mapping = suggestMapping(headers, records);
    res.json({
      fileName: req.file.originalname,
      headers,
      rowCount: records.length,
      blankRows,
      delimiter,
      fields: FIELDS,
      suggestedMapping: mapping,
      samples: Object.fromEntries(headers.map((h) => [h, records.slice(0, 3).map((r) => r.values[h]).filter(Boolean)])),
    });
  }));

  // Step 2/3: dry-run (dryRun=true) returns the plan; otherwise the same plan is applied.
  app.post('/api/import', upload.single('file'), wrap(async (req, res) => {
    const { headers, records } = readFile(req);
    const mapping = jsonField(req, 'mapping', null) ?? suggestMapping(headers, records);
    const problem = validateMapping(mapping, headers);
    if (problem) throw bad(problem);
    const policy = req.body.policy || 'skip';
    if (!['skip', 'update'].includes(policy)) throw bad('policy must be "skip" or "update".');
    const decisions = jsonField(req, 'decisions', {});
    if (typeof decisions !== 'object' || Array.isArray(decisions)) throw bad('decisions must be an object.');
    const dryRun = req.body.dryRun === 'true';

    const existing = await Company.find({}).lean();
    const plan = planImport({
      existing,
      records,
      mapping,
      headers,
      policy,
      decisions,
      validate: (doc) => new Company(doc).validateSync()?.message,
    });

    if (!dryRun) {
      try {
        for (let i = 0; i < plan.toInsert.length; i += BATCH) {
          await Company.insertMany(plan.toInsert.slice(i, i + BATCH), { ordered: false });
        }
        for (let i = 0; i < plan.toUpdate.length; i += BATCH) {
          await Company.bulkWrite(
            plan.toUpdate.slice(i, i + BATCH).map((u) => ({ updateOne: { filter: { _id: u.id }, update: { $set: u.set } } }))
          );
        }
      } catch (e) {
        console.error(e);
        throw Object.assign(
          new Error('The import stopped partway because of a database error. Re-running the same file is safe: rows already imported are detected as duplicates.'),
          { status: 500 }
        );
      }
    }
    res.json(publicPlan(plan, { dryRun, headers }));
  }));

  app.get('/api/export', wrap(async (req, res) => {
    const items = await Company.find(buildFilter(req.query)).sort(sortFor(req.query.sort)).lean();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="startups.csv"');
    res.send(buildCsv(items));
  }));
}
