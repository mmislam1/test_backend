import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IXXPayment extends Document {
  userId: Types.ObjectId;
  xxSubscriptionId?: Types.ObjectId;
  amount: number;
  currency: string;
  status: 'completed' | 'failed' | 'refunded';
  paddleTransactionId: string;
  paddleSubscriptionId?: string;
  createdAt: Date;
}

const XXPaymentSchema = new Schema<IXXPayment>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  xxSubscriptionId: { type: Schema.Types.ObjectId, ref: 'XXSubscription' },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['completed', 'failed', 'refunded'], required: true },
  paddleTransactionId: { type: String, required: true, unique: true },
  paddleSubscriptionId: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export const XXPayment =
  mongoose.models.XXPayment || mongoose.model<IXXPayment>('XXPayment', XXPaymentSchema);
