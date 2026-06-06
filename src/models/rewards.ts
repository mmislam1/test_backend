import mongoose, { Schema, Document } from 'mongoose';

export interface IReward extends Document {
  title: string;             // e.g., "PDF Generator"
  slug: string;              // e.g., "pdf-generator" (used in code)
  referralsRequired: number; // 2, 3, 5, etc.
  description?: string;
  isActive: boolean;
}

const RewardSchema = new Schema<IReward>({
  title: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  referralsRequired: { type: Number, required: true, min: 1 },
  description: { type: String },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export const Reward = mongoose.model<IReward>('Reward', RewardSchema);