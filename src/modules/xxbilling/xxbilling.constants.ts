import type { XXBillingCycle, XXPlanTier } from '../../models/xxplan';

export type PlanTier = XXPlanTier;
export type BillingCycle = XXBillingCycle;

export interface XXPlanDefinition {
  tier: XXPlanTier;
  name: string;
  imageUploadLimit: number;
  contentsMonitored: number;
  resultViewLimit: number;
  alertLimit: number;
  pdfEnabled: boolean;
  weeklyEmailAlerts: boolean;
  features: string[];
  pricing: {
    monthly: number;
    annual: number;
    annualTotal: number;
    annualDiscountPercent: number;
  };
  costPerItemYearly: number;
  trialDays: number;
  paddleMonthlyPriceId?: string;
  paddleAnnualPriceId?: string;
}

export type PlanDefinition = XXPlanDefinition;

const envInt = (key: string, fallback: number): number => {
  const value = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const priceIdFromEnv = (tier: string, cycle: 'MONTHLY' | 'ANNUAL') =>
  process.env[`XX_PADDLE_${tier}_${cycle}_PRICE_ID`]
  ?? process.env[`PADDLE_${tier}_${cycle}_PRICE_ID`];

const resultLimit = (key: string, fallback: number) => envInt(key, fallback);

export const XX_TRIAL_DAYS = envInt('XX_TRIAL_DAYS_PRO', envInt('TRIAL_DAYS_PRO', 7)) || 7;

export const XX_PLAN_DEFINITIONS: XXPlanDefinition[] = [
  {
    tier: 'starter',
    name: 'Starter',
    imageUploadLimit: 10,
    contentsMonitored: 10,
    resultViewLimit: resultLimit('STARTER_RESULT_VIEW_LIMIT', 1000),
    alertLimit: 1000,
    pdfEnabled: false,
    weeklyEmailAlerts: true,
    features: [
      'Monitor up to 10 registered items',
      'View up to 1,000 results per search',
      '1,000 cumulative discovery alerts',
      'Automatic duplicate filtering',
      'Content exposure risk analysis',
      'In-app notifications',
    ],
    pricing: {
      monthly: 6.60,
      annual: 5.20,
      annualTotal: 62.40,
      annualDiscountPercent: 20,
    },
    costPerItemYearly: 0.53,
    trialDays: 0,
    paddleMonthlyPriceId: priceIdFromEnv('STARTER', 'MONTHLY'),
    paddleAnnualPriceId: priceIdFromEnv('STARTER', 'ANNUAL'),
  },
  {
    tier: 'pro',
    name: 'Pro',
    imageUploadLimit: 50,
    contentsMonitored: 50,
    resultViewLimit: resultLimit('PRO_RESULT_VIEW_LIMIT', 5000),
    alertLimit: 5000,
    pdfEnabled: true,
    weeklyEmailAlerts: true,
    features: [
      'Monitor up to 50 registered items',
      'View up to 5,000 results per search',
      '5,000 cumulative discovery alerts',
      'Automatic duplicate filtering',
      'Content exposure risk analysis',
      'PDF report generation',
      'In-app notifications',
    ],
    pricing: {
      monthly: 19.30,
      annual: 13.50,
      annualTotal: 162.00,
      annualDiscountPercent: 30,
    },
    costPerItemYearly: 0.27,
    trialDays: XX_TRIAL_DAYS,
    paddleMonthlyPriceId: priceIdFromEnv('PRO', 'MONTHLY'),
    paddleAnnualPriceId: priceIdFromEnv('PRO', 'ANNUAL'),
  },
  {
    tier: 'premium',
    name: 'Premium',
    imageUploadLimit: 100,
    contentsMonitored: 100,
    resultViewLimit: resultLimit('PREMIUM_RESULT_VIEW_LIMIT', 0),
    alertLimit: 0,
    pdfEnabled: true,
    weeklyEmailAlerts: true,
    features: [
      'Monitor up to 100 registered items',
      'Unlimited result visibility per search',
      'Unlimited discovery alerts',
      'Automatic duplicate filtering',
      'Content exposure risk analysis',
      'PDF report generation',
      '1:1 dedicated manager',
      'In-app notifications',
    ],
    pricing: {
      monthly: 32.70,
      annual: 19.60,
      annualTotal: 235.20,
      annualDiscountPercent: 40,
    },
    costPerItemYearly: 0.20,
    trialDays: 0,
    paddleMonthlyPriceId: priceIdFromEnv('PREMIUM', 'MONTHLY'),
    paddleAnnualPriceId: priceIdFromEnv('PREMIUM', 'ANNUAL'),
  },
];

export const PLAN_DEFINITIONS = XX_PLAN_DEFINITIONS;

export const getXXPlanDefinition = (tier: XXPlanTier): XXPlanDefinition =>
  XX_PLAN_DEFINITIONS.find((plan) => plan.tier === tier) ?? XX_PLAN_DEFINITIONS[0];

export const getPlanDefinition = getXXPlanDefinition;

export const getXXPriceId = (tier: XXPlanTier, cycle: XXBillingCycle): string | undefined => {
  const plan = getXXPlanDefinition(tier);
  return cycle === 'annual' ? plan.paddleAnnualPriceId : plan.paddleMonthlyPriceId;
};
