import mongoose from 'mongoose';
import { STATUSES, FUNDING_STATUSES, FUNDING_STAGES } from '../lib/csv.js';

// One piece of researched evidence. Always tied to the page it came from and when it was observed.
const findingSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['careers', 'email', 'role', 'website', 'funding'], required: true },
    value: { type: String, required: true }, // URL, email address, or (funding) the quoted sentence
    title: String, // roles only
    sourceUrl: { type: String, required: true },
    observedAt: { type: Date, required: true },
    basis: { type: String, required: true }, // how it was found, e.g. official-link, keyword-match
    // verified = observed directly on an official-site page; inferred = a keyword/text lead;
    // unverified = weak or company-claim only (unloaded link, redirect target, funding statement)
    confidence: { type: String, enum: ['verified', 'inferred', 'unverified'], required: true },
    evidence: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    decidedAt: Date,
    seenInLatestRun: { type: Boolean, default: true },
  },
  { timestamps: false }
);

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    website: { type: String, default: '' },
    domain: { type: String, default: '', index: true },
    location: { type: String, default: '' },
    industry: { type: String, default: '' },

    // Funding is imported or user-entered, or applied from a finding the user accepted.
    fundingStatus: { type: String, enum: FUNDING_STATUSES, default: 'unknown' },
    fundingStage: { type: String, enum: FUNDING_STAGES, default: 'unknown' },
    fundingAmount: { type: String, default: '' },
    fundingDate: { type: String, default: '' },
    fundingSourceUrl: { type: String, default: '' },
    fundingVerified: { type: Boolean, default: false },

    careersUrl: { type: String, default: '' },
    careersSourceUrl: { type: String, default: '' },
    careersVerified: { type: Boolean, default: false },
    contactEmail: { type: String, default: '' },
    contactEmailSourceUrl: { type: String, default: '' },
    contactName: { type: String, default: '' },

    hasRelevantRoles: { type: String, enum: ['unknown', 'yes', 'no'], default: 'unknown' },
    openRoles: [{ _id: false, title: String, url: String, sourceUrl: String, observedAt: Date }],

    findings: { type: [findingSchema], default: [] },
    researchStatus: {
      type: String,
      enum: ['not_researched', 'running', 'researched', 'partial', 'not_found', 'failed'],
      default: 'not_researched',
    },
    researchStartedAt: Date,
    researchedAt: Date,
    researchProgress: { type: String, default: '' },
    researchError: { type: new mongoose.Schema({ code: String, message: String, retryable: Boolean }, { _id: false }), default: undefined },
    researchNotFound: { type: [String], default: [] },
    researchPages: { type: Number, default: 0 },
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
