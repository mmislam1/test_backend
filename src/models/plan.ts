import mongoose, { Schema, Document } from 'mongoose';

export type PlanTier = 'starter' | 'pro' | 'premium';

export interface IPlan extends Document {
  tier: PlanTier;
  name: string;
  imageUploadLimit: number;   // searches per billing period (registered items)
  alertLimit: number;          // cumulative notification alerts per billing period; 0 = unlimited
  pdfEnabled: boolean;
  weeklyEmailAlerts: boolean;
  monthlyPrice: number;        // USD/month billed monthly
  annualPrice: number;         // USD/month billed annually
  trialDays: number;           // 0 = no trial; >0 = free trial length in days
  paddleMonthlyPriceId?: string;  // Paddle price ID for monthly billing
  paddleAnnualPriceId?: string;   // Paddle price ID for annual billing
  paddleTrialPriceId?: string;    // Paddle price ID with trial period configured (optional)
}

const PlanSchema = new Schema<IPlan>(
  {
    tier:              { type: String, enum: ['starter', 'pro', 'premium'], required: true, unique: true },
    name:              { type: String, required: true },
    imageUploadLimit:  { type: Number, required: true },
    alertLimit:        { type: Number, required: true },
    pdfEnabled:        { type: Boolean, default: false },
    weeklyEmailAlerts: { type: Boolean, default: true },
    monthlyPrice:      { type: Number, required: true },
    annualPrice:       { type: Number, required: true },
    trialDays:         { type: Number, default: 0 },
    paddleMonthlyPriceId: { type: String },
    paddleAnnualPriceId:  { type: String },
    paddleTrialPriceId:   { type: String },
  },
  { timestamps: true },
);

export const Plan = mongoose.model<IPlan>('Plan', PlanSchema);