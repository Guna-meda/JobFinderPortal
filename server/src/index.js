import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { createResearchService } from './lib/researchService.js';

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

const research = createResearchService();
const recovered = await research.recoverInterrupted();
if (recovered) console.log(`Marked ${recovered} interrupted research run(s) as failed so they can be retried.`);

createApp({ research }).listen(port, () => console.log(`API listening on http://localhost:${port}`));
