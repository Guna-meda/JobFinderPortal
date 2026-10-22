// `npm --prefix server run check:integrity` reports inconsistencies between companies, applications and drafts.
// Add `-- --repair` to recompute company summaries and clear dangling draft pointers. It never deletes records:
// orphaned applications and drafts are only listed so you can decide what to do with them.
import 'dotenv/config';
import mongoose from 'mongoose';
import { createApplicationService } from '../src/lib/applicationService.js';
import { checkIntegrity } from '../src/lib/integrity.js';

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/startup-finder';
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
} catch (e) {
  console.error(`Could not connect to MongoDB: ${e.message}`);
  process.exit(1);
}
const repair = process.argv.includes('--repair');
const result = await checkIntegrity({ repair, apps: createApplicationService() });
console.log(JSON.stringify(result, null, 2));
console.log(result.ok ? 'Everything is consistent.' : repair ? `Repaired ${result.repaired} item(s). Orphans (if any) are listed above and were not deleted.` : 'Inconsistencies found. Re-run with --repair to fix summaries; orphans need a manual decision.');
await mongoose.disconnect();
process.exitCode = result.ok || repair ? 0 : 2;
