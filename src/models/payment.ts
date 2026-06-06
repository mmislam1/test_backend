import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IPayment extends Document {
  userId: Types.ObjectId;
  subscriptionPlanId?: Types.ObjectId;
  amount: number;
  currency: string;
  status: 'completed' | 'failed' | 'refunded';
  paddleTransactionId: string;         
  paddleSubscriptionId?: string;     
  createdAt: Date;
}

const PaymentSchema = new Schema<IPayment>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  subscriptionPlanId: { type: Schema.Types.ObjectId, ref: 'Subscription' },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['completed', 'failed', 'refunded'], required: true },
  
paddleTransactionId: { type: String, required: true, unique: true },
paddleSubscriptionId: { type: String }, 
  createdAt: { type: Date, default: Date.now },
});

export const Payment = mongoose.models.Payment || mongoose.model<IPayment>('Payment', PaymentSchema);