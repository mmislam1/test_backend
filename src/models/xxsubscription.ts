import mongoose, { Schema, Document, Types } from 'mongoose';

export type XxPlanTier = 'starter' | 'pro' | 'premium';
export type XxBillingCycle = 'monthly' | 'annual';
export type XxSubscriptionStatus =
  | 'pending'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled'
  | 'expired';
export type XxSubscriptionSource = 'trial' | 'paddle';

export interface IXxScheduledChange {
  planTier: XxPlanTier;
  billingCycle: XxBillingCycle;
  effectiveAt: Date;
  requestedAt: Date;
  paddlePriceId?: string;
  paddleSyncedAt?: Date;
  status: 'scheduled' | 'canceled' | 'activated';
}

export interface IXxSubscription extends Document {
  userId: Types.ObjectId;
  planTier: XxPlanTier;
  billingCycle: XxBillingCycle;
  source: XxSubscriptionSource;
  status: XxSubscriptionStatus;
  activationDate: Date;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  nextBillingDate?: Date;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  cancelAt?: Date;
  canceledAt?: Date;
  paddleCustomerId?: string;
  paddleSubscriptionId?: string;
  paddlePriceId?: string;
  scheduledChange?: IXxScheduledChange;
  lastEntitlementGrantKey?: string;
  lastPaddleEventId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const XxScheduledChangeSchema = new Schema<IXxScheduledChange>(
  {
    planTier: { type: String, enum: ['starter', 'pro', 'premium'], required: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], required: true },
    effectiveAt: { type: Date, required: true },
    requestedAt: { type: Date, default: Date.now },
    paddlePriceId: { type: String },
    paddleSyncedAt: { type: Date },
    status: {
      type: String,
      enum: ['scheduled', 'canceled', 'activated'],
      default: 'scheduled',
    },
  },
  { _id: false },
);

const XxSubscriptionSchema = new Schema<IXxSubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planTier: { type: String, enum: ['starter', 'pro', 'premium'], required: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    source: { type: String, enum: ['trial', 'paddle'], required: true },
    status: {
      type: String,
      enum: ['pending', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired'],
      default: 'pending',
    },
    activationDate: { type: Date, default: Date.now },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    trialEndsAt: { type: Date },
    nextBillingDate: { type: Date },
    autoRenew: { type: Boolean, default: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelAt: { type: Date },
    canceledAt: { type: Date },
    paddleCustomerId: { type: String },
    paddleSubscriptionId: { type: String },
    paddlePriceId: { type: String },
    scheduledChange: { type: XxScheduledChangeSchema },
    lastEntitlementGrantKey: { type: String },
    lastPaddleEventId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

XxSubscriptionSchema.index({ userId: 1, status: 1, activationDate: -1 });
XxSubscriptionSchema.index({ paddleSubscriptionId: 1 }, { unique: true, sparse: true });
XxSubscriptionSchema.index(
  { userId: 1, source: 1 },
  { unique: true, partialFilterExpression: { source: 'trial' } },
);

export const XxSubscription =
  mongoose.models.XxSubscription ||
  mongoose.model<IXxSubscription>('XxSubscription', XxSubscriptionSchema);
