import mongoose from 'mongoose';
import { STATUSES, FUNDING_STATUSES, FUNDING_STAGES } from '../lib/csv.js';

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    website: { type: String, default: '' },
    domain: { type: String, default: '', index: true },
    location: { type: String, default: '' },
    industry: { type: String, default: '' },

    // Funding is imported or user-entered. Research never fills it.
    fundingStatus: { type: String, enum: FUNDING_STATUSES, default: 'unknown' },
    fundingStage: { type: String, enum: FUNDING_STAGES, default: 'unknown' },
    fundingSourceUrl: { type: String, default: '' },
    fundingVerified: { type: Boolean, default: false },

    careersUrl: { type: String, default: '' },
    careersSourceUrl: { type: String, default: '' },
    careersVerified: { type: Boolean, default: false },
    contactEmail: { type: String, default: '' },
    contactEmailSourceUrl: { type: String, default: '' },
    contactName: { type: String, default: '' },

    hasRelevantRoles: { type: String, enum: ['unknown', 'yes', 'no'], default: 'unknown' },
    openRoles: [{ _id: false, title: String, url: String }],

    researchStatus: {
      type: String,
      enum: ['not_researched', 'researched', 'partial', 'failed'],
      default: 'not_researched',
    },
    researchedAt: Date,
    researchLog: { type: [String], default: [] },

    appStatus: { type: String, enum: STATUSES, default: 'Not Applied', index: true },
    appliedDate: Date,
    followUpDate: Date,
    notes: { type: String, default: '' },
    extra: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export default mongoose.model('Company', schema);
