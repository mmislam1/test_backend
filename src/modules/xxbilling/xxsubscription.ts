import mongoose, { Schema, Document, Types } from 'mongoose';
import type { XXBillingCycle, XXPlanTier } from '../../models/xxplan';

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
  /**
   * Set when a paid downgrade is purchased while a local trial is active.
   * The subscription stays `pending` until this date (= trial's currentPeriodEnd),
   * at which point the trial-expiry worker flips it to `active`.
   */
  deferredActivationDate?: Date;
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
    deferredActivationDate: { type: Date },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

XXSubscriptionSchema.index({ userId: 1, status: 1, activationDate: -1 });
XXSubscriptionSchema.index({ paddleSubscriptionId: 1 }, { unique: true, sparse: true });

export const XXSubscription =
  mongoose.models.XXSubscription || mongoose.model<IXXSubscription>('XXSubscription', XXSubscriptionSchema);
