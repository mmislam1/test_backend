export type XxPlanTier = 'starter' | 'pro' | 'premium';
export type XxPlanInput = XxPlanTier | 'standard';
export type XxBillingCycle = 'monthly' | 'annual';

export interface XxPlanDefinition {
  tier: XxPlanTier;
  aliases: string[];
  name: string;
  monthlyPrice: number;
  annualMonthlyPrice: number;
  annualTotal: number;
  yearlyDiscountPercent: number;
  monitors: number;
  alertLimit: number | null;
  yearlyCostPerItem: number;
  paddleMonthlyPriceId?: string;
  paddleAnnualPriceId?: string;
}

export interface XxCheckoutRequest {
  tier?: XxPlanInput;
  billingCycle?: XxBillingCycle;
}
