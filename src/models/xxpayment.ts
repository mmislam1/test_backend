import mongoose, { Schema, Document, Types } from 'mongoose';
import type { XxBillingCycle, XxPlanTier } from './xxsubscription';

export type XxPaymentStatus = 'completed' | 'failed';

export interface IXxPayment extends Document {
  userId: Types.ObjectId;
  xxSubscriptionId?: Types.ObjectId;
  planTier?: XxPlanTier;
  billingCycle?: XxBillingCycle;
  amount: number;
  currency: string;
  status: XxPaymentStatus;
  paddleTransactionId: string;
  paddleSubscriptionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const XxPaymentSchema = new Schema<IXxPayment>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    xxSubscriptionId: { type: Schema.Types.ObjectId, ref: 'XxSubscription' },
    planTier: { type: String, enum: ['starter', 'pro', 'premium'] },
    billingCycle: { type: String, enum: ['monthly', 'annual'] },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['completed', 'failed'], required: true },
    paddleTransactionId: { type: String, required: true, unique: true },
    paddleSubscriptionId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

XxPaymentSchema.index({ userId: 1, createdAt: -1 });
XxPaymentSchema.index({ paddleSubscriptionId: 1 });

export const XxPayment =
  mongoose.models.XxPayment || mongoose.model<IXxPayment>('XxPayment', XxPaymentSchema);
