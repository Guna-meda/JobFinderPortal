// Optional manual run of the application migration: `npm run migrate:applications` (from the server folder,
// or `npm --prefix server run migrate:applications`). The server also runs this automatically on every start.
// It is idempotent and non-destructive: it only creates application records for companies that carry
// company-level tracking data but have none, and it never deletes or rewrites existing data.
import 'dotenv/config';
import mongoose from 'mongoose';
import Application from '../src/models/Application.js';
import { createApplicationService } from '../src/lib/applicationService.js';

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/startup-finder';
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
} catch (e) {
  console.error(`Could not connect to MongoDB: ${e.message}`);
  process.exit(1);
}
await Application.init();
const result = await createApplicationService().migrateAll();
console.log(`Companies with tracking data but no applications: ${result.candidates}. Application records created: ${result.created}.`);
await mongoose.disconnect();
