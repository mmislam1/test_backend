import mongoose, { Schema, Document, Types } from 'mongoose';
import type { XXBillingCycle, XXPlanTier } from './xxplan';

export type XXSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'cancelled'
  | 'expired'
  | 'pending'
  | 'past_due'
  | 'paused';

export type XXGrantSource = 'trial' | 'referral' | 'paid';

export interface IXXSubscription extends Document {
  userId: Types.ObjectId;
  planTier: XXPlanTier;
  billingCycle: XXBillingCycle;
  nextPlanTier?: XXPlanTier;
  nextBillingCycle?: XXBillingCycle;
  grantSource: XXGrantSource;
  status: XXSubscriptionStatus;
  activationDate: Date;
  currentPeriodEnd?: Date;
  nextBillingDate?: Date;
  trialEndDate?: Date;
  cancelDate?: Date;
  autoRenewEnabled: boolean;
  paddleSubscriptionId?: string;
  paddleCustomerId?: string;
  paddlePriceId?: string;
  lastEntitlementGrantKey?: string;
  autoRenewReminderStages: number[];
  trialReminderStages: number[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const XXSubscriptionSchema = new Schema<IXXSubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planTier: { type: String, enum: ['starter', 'pro', 'premium'], required: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    nextPlanTier: { type: String, enum: ['starter', 'pro', 'premium'] },
    nextBillingCycle: { type: String, enum: ['monthly', 'annual'] },
    grantSource: { type: String, enum: ['trial', 'referral', 'paid'], default: 'paid' },
    status: {
      type: String,
      enum: ['active', 'trialing', 'cancelled', 'expired', 'pending', 'past_due', 'paused'],
      default: 'pending',
    },
    activationDate: { type: Date, default: Date.now },
    currentPeriodEnd: { type: Date },
    nextBillingDate: { type: Date },
    trialEndDate: { type: Date },
    cancelDate: { type: Date },
    autoRenewEnabled: { type: Boolean, default: true },
    paddleSubscriptionId: { type: String },
    paddleCustomerId: { type: String },
    paddlePriceId: { type: String },
    lastEntitlementGrantKey: { type: String },
    autoRenewReminderStages: { type: [Number], default: [] },
    trialReminderStages: { type: [Number], default: [] },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

XXSubscriptionSchema.index({ userId: 1, status: 1, activationDate: -1 });
XXSubscriptionSchema.index({ paddleSubscriptionId: 1 }, { unique: true, sparse: true });

export const XXSubscription =
  mongoose.models.XXSubscription || mongoose.model<IXXSubscription>('XXSubscription', XXSubscriptionSchema);
