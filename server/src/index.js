import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import Application from './models/Application.js';
import { createResearchService } from './lib/researchService.js';
import { createApplicationService } from './lib/applicationService.js';
import { createOutreachService } from './lib/outreachService.js';
import { checkIntegrity } from './lib/integrity.js';
import { maskUri } from './lib/mask.js';

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/startup-finder';
const port = process.env.PORT || 4000;

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`MongoDB connected: ${maskUri(uri)}`);
} catch (e) {
  console.error(`\nCould not connect to MongoDB at ${maskUri(uri)}\n${maskUri(e.message)}`);
  console.error('Start MongoDB (see README: "docker compose up -d") or set MONGO_URI in server/.env\n');
  process.exit(1);
}

// Make sure the duplicate-protection indexes exist before serving requests.
await Application.init();
const applications = createApplicationService();
const migrated = await applications.migrateAll();
if (migrated.created) console.log(`Converted tracking data for ${migrated.created} compan${migrated.created === 1 ? 'y' : 'ies'} into application records.`);

const integrity = await checkIntegrity({ apps: applications });
if (!integrity.ok) console.warn('Data check found inconsistencies. Run: npm --prefix server run check:integrity (add -- --repair to fix summaries). Nothing was changed.');

const research = createResearchService();
const recovered = await research.recoverInterrupted();
if (recovered) console.log(`Marked ${recovered} interrupted research run(s) as failed so they can be retried.`);

const outreach = createOutreachService({ apps: applications });
console.log(outreach.config().aiAvailable ? `Outreach drafts: AI enabled (${outreach.config().model}); templates are the fallback.` : 'Outreach drafts: template mode (set ANTHROPIC_API_KEY in server/.env to enable AI drafts).');

// Local tool, no login: listen on this machine only (set HOST to change it deliberately).
const host = process.env.HOST || '127.0.0.1';
const server = createApp({ research, applications, outreach }).listen(port, host, () => console.log(`API listening on http://${host}:${port}`));
server.requestTimeout = 60_000; // a whole request must arrive within a minute
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
