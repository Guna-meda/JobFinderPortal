import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import Application from './models/Application.js';
import { createResearchService } from './lib/researchService.js';
import { createApplicationService } from './lib/applicationService.js';

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/startup-finder';
const port = process.env.PORT || 4000;

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`MongoDB connected: ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
} catch (e) {
  console.error(`\nCould not connect to MongoDB at ${uri.replace(/\/\/[^@]*@/, '//***@')}\n${e.message}`);
  console.error('Start MongoDB (see README: "docker compose up -d") or set MONGO_URI in server/.env\n');
  process.exit(1);
}

// Make sure the duplicate-protection indexes exist before serving requests.
await Application.init();
const applications = createApplicationService();
const migrated = await applications.migrateAll();
if (migrated.created) console.log(`Converted tracking data for ${migrated.created} compan${migrated.created === 1 ? 'y' : 'ies'} into application records.`);

const research = createResearchService();
const recovered = await research.recoverInterrupted();
if (recovered) console.log(`Marked ${recovered} interrupted research run(s) as failed so they can be retried.`);

createApp({ research, applications }).listen(port, () => console.log(`API listening on http://localhost:${port}`));
