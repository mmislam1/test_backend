import mongoose, { Schema, Document, Types } from 'mongoose';

export type BillingCycle = 'monthly' | 'annual';
export type SubscriptionStatus = 'active' | 'trialing' | 'cancelled' | 'expired' | 'pending' | 'past_due' | 'paused';

export interface ISubscription extends Document {
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  lockedPlanId?: Types.ObjectId;
  nextPlanId?: Types.ObjectId;
  billingCycle: BillingCycle;
  lockedBillingCycle?: BillingCycle;
  nextBillingCycle?: BillingCycle;
  grantSource?: 'trial' | 'referral' | 'paid';
  activationDate: Date;
  cancelDate?: Date;
  currentPeriodEnd?: Date;
  trialEndDate?: Date;          // set when status=trialing; cleared on conversion to active
  status: SubscriptionStatus;
  paddleSubscriptionId?: string;  // populated when Paddle is integrated
  paddleCustomerId?: string;      // Paddle customer ID, used for portal sessions
  nextBillingDate?: Date;
  autoRenewReminderStages?: number[]; // sent reminder checkpoints (days left) for scheduled cancellation
  trialReminderStages?: number[]; // sent reminder checkpoints (days left) for trial ending reminders
  bonusSearches: number;          // carry-over searches added on upgrade
  bonusAlerts: number;            // carry-over alerts added on upgrade
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    userId:               { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planId:               { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    lockedPlanId:         { type: Schema.Types.ObjectId, ref: 'Plan' },
    nextPlanId:           { type: Schema.Types.ObjectId, ref: 'Plan' },
    billingCycle:         { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    lockedBillingCycle:   { type: String, enum: ['monthly', 'annual'] },
    nextBillingCycle:     { type: String, enum: ['monthly', 'annual'] },
    grantSource:          { type: String, enum: ['trial', 'referral', 'paid'], default: 'paid' },
    activationDate:       { type: Date, default: Date.now },
    cancelDate:           { type: Date },
    currentPeriodEnd:     { type: Date },
    trialEndDate:         { type: Date },
    // Populated only for Paddle-managed subscriptions; absent for manual/admin-created ones.
    paddleSubscriptionId: { type: String },
    paddleCustomerId:     { type: String },
    autoRenewReminderStages: { type: [Number], default: [] },
    trialReminderStages: { type: [Number], default: [] },
    status: {
      type: String,
      enum: ['active', 'trialing', 'cancelled', 'expired', 'pending', 'past_due', 'paused'],
      default: 'pending',
    },
    nextBillingDate:      { type: Date },
    bonusSearches:        { type: Number, default: 0 },
    bonusAlerts:          { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Sparse so that multiple documents can have no paddleSubscriptionId (null),
// while still enforcing uniqueness across Paddle-managed subscriptions.
SubscriptionSchema.index({ paddleSubscriptionId: 1 }, { unique: true, sparse: true });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);