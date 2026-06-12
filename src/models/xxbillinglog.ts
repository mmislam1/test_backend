import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IXXBillingLog extends Document {
  userId?: Types.ObjectId;
  event: string;
  level: 'info' | 'warn' | 'error';
  source: 'api' | 'paddle' | 'worker' | 'reward';
  message: string;
  paddleSubscriptionId?: string;
  paddleTransactionId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const XXBillingLogSchema = new Schema<IXXBillingLog>({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  event: { type: String, required: true, index: true },
  level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
  source: { type: String, enum: ['api', 'paddle', 'worker', 'reward'], required: true },
  message: { type: String, required: true },
  paddleSubscriptionId: { type: String },
  paddleTransactionId: { type: String },
  metadata: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

XXBillingLogSchema.index({ userId: 1, createdAt: -1 });

export const XXBillingLog =
  mongoose.models.XXBillingLog || mongoose.model<IXXBillingLog>('XXBillingLog', XXBillingLogSchema);
