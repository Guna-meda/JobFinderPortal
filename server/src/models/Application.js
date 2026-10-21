import mongoose from 'mongoose';
import { STATUSES } from '../lib/csv.js';

export const ACTIVITY_TYPES = ['created', 'status', 'applied', 'followUp', 'contact', 'details', 'note', 'migrated'];

const activitySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    summary: { type: String, maxlength: 600, required: true },
    from: String,
    to: String,
  },
  { _id: false }
);

// One application = one role at one company. A company can have several, each with its own status.
const schema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    role: { type: String, default: '', maxlength: 200, trim: true }, // '' = a general application to the company
    roleKey: { type: String, default: '' }, // normalised role, used for duplicate detection
    jobUrl: { type: String, default: '', maxlength: 2048 },
    jobUrlKey: { type: String, default: '' },
    status: { type: String, enum: STATUSES, default: 'To Apply', index: true },
    appliedDate: Date,
    lastContactDate: Date,
    followUpDate: { type: Date, index: true },
    contactName: { type: String, default: '', maxlength: 200 },
    contactEmail: { type: String, default: '', maxlength: 254 },
    contactUrl: { type: String, default: '', maxlength: 2048 },
    nextAction: { type: String, default: '', maxlength: 300 },
    notes: { type: String, default: '', maxlength: 5000 },
    history: { type: [activitySchema], default: [] },
  },
  { timestamps: true }
);

// The database itself refuses duplicates, even for two requests that race each other.
schema.index({ company: 1, roleKey: 1 }, { unique: true });
schema.index({ company: 1, jobUrlKey: 1 }, { unique: true, partialFilterExpression: { jobUrlKey: { $gt: '' } } });

export default mongoose.model('Application', schema);
