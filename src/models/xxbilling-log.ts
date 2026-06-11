import mongoose, { Schema, Document, Types } from 'mongoose';

export type XxBillingLogLevel = 'info' | 'warning' | 'error';

export interface IXxBillingLog extends Document {
  userId?: Types.ObjectId;
  xxSubscriptionId?: Types.ObjectId;
  level: XxBillingLogLevel;
  eventType: string;
  message: string;
  notifyFrontend: boolean;
  isRead: boolean;
  paddleEventId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const XxBillingLogSchema = new Schema<IXxBillingLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    xxSubscriptionId: { type: Schema.Types.ObjectId, ref: 'XxSubscription' },
    level: { type: String, enum: ['info', 'warning', 'error'], default: 'info' },
    eventType: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    notifyFrontend: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
    paddleEventId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

XxBillingLogSchema.index({ userId: 1, notifyFrontend: 1, isRead: 1, createdAt: -1 });
XxBillingLogSchema.index({ paddleEventId: 1 }, { sparse: true });

export const XxBillingLog =
  mongoose.models.XxBillingLog ||
  mongoose.model<IXxBillingLog>('XxBillingLog', XxBillingLogSchema);
