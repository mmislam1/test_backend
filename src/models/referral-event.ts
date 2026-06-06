import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Tracks each individual referral event so we can:
 * 1. Count how many referred users logged in (completed) within the 24-h window.
 * 2. Avoid double-counting.
 */
export interface IReferralEvent extends Document {
  referrerId: Types.ObjectId;    // the user who shared the code
  referredUserId: Types.ObjectId; // the new user who used the code
  signedUpAt: Date;               // when the new user registered
  completedAt?: Date;             // when the new user first logged in (nil until then)
  isCompleted: boolean;           // true once the referred user logs in for the first time
}

const ReferralEventSchema = new Schema<IReferralEvent>(
  {
    referrerId:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
    referredUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    signedUpAt:     { type: Date, default: Date.now },
    completedAt:    { type: Date },
    isCompleted:    { type: Boolean, default: false },
  },
  { timestamps: true },
);

ReferralEventSchema.index({ referrerId: 1, isCompleted: 1 });

export const ReferralEvent =
  mongoose.model<IReferralEvent>('ReferralEvent', ReferralEventSchema);
