import mongoose, { Schema, Document } from 'mongoose';

export type XXPlanTier = 'starter' | 'pro' | 'premium';
export type XXBillingCycle = 'monthly' | 'annual';

export interface IXXPlan extends Document {
  tier: XXPlanTier;
  name: string;
  contentsMonitored: number;
  imageUploadLimit: number;
  resultViewLimit: number;
  alertLimit: number;
  pdfEnabled: boolean;
  weeklyEmailAlerts: boolean;
  monthlyPrice: number;
  annualPrice: number;
  annualTotal: number;
  annualDiscountPercent: number;
  costPerItemYearly: number;
  trialDays: number;
  features: string[];
  paddleMonthlyPriceId?: string;
  paddleAnnualPriceId?: string;
}

const XXPlanSchema = new Schema<IXXPlan>(
  {
    tier: { type: String, enum: ['starter', 'pro', 'premium'], required: true, unique: true },
    name: { type: String, required: true },
    contentsMonitored: { type: Number, required: true },
    imageUploadLimit: { type: Number, required: true },
    resultViewLimit: { type: Number, required: true },
    alertLimit: { type: Number, required: true },
    pdfEnabled: { type: Boolean, default: false },
    weeklyEmailAlerts: { type: Boolean, default: true },
    monthlyPrice: { type: Number, required: true },
    annualPrice: { type: Number, required: true },
    annualTotal: { type: Number, required: true },
    annualDiscountPercent: { type: Number, required: true },
    costPerItemYearly: { type: Number, required: true },
    trialDays: { type: Number, default: 0 },
    features: { type: [String], default: [] },
    paddleMonthlyPriceId: { type: String },
    paddleAnnualPriceId: { type: String },
  },
  { timestamps: true },
);

export const XXPlan = mongoose.models.XXPlan || mongoose.model<IXXPlan>('XXPlan', XXPlanSchema);
