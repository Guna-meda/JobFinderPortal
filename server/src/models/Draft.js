import mongoose from 'mongoose';
import { PURPOSE_KEYS } from '../lib/outreach.js';

// An email draft saved against a company (and optionally one of its applications). Nothing here is ever sent
// by the app: "sent" only records that you sent it yourself, and when.
const factSchema = new mongoose.Schema(
  {
    key: String,
    label: String,
    value: { type: String, maxlength: 600 },
    basis: { type: String, enum: ['verified', 'record', 'you'] },
    source: String,
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
    purpose: { type: String, enum: PURPOSE_KEYS, required: true },
    role: { type: String, default: '', maxlength: 200 },
    subject: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 5000 },
    generatedBy: { type: String, enum: ['template', 'ai', 'manual'], default: 'manual' },
    facts: { type: [factSchema], default: [] },
    status: { type: String, enum: ['draft', 'sent'], default: 'draft' },
    sentAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model('Draft', schema);
