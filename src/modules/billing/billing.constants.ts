import type { PlanTier } from '../../models/plan';

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  imageUploadLimit: number;  // searches per billing period (registered items)
  resultViewLimit: number;   // max visible results per scan response; 0 = unlimited
  alertLimit: number;         // cumulative notification alerts per billing period; 0 = unlimited
  pdfEnabled: boolean;
  weeklyEmailAlerts: boolean;
  features: string[];
  pricing: {
    monthly: number;   // billed monthly
    annual: number;    // per-month cost when billed annually
  };
  // Trial configuration — trialDays read from env (e.g. TRIAL_DAYS_STARTER) with fallback to TRIAL_DAYS_DEFAULT
  trialDays: number;
  // Paddle price IDs — set via environment variables
  paddleMonthlyPriceId?: string;
  paddleAnnualPriceId?: string;
  // Optional: a Paddle price with trial_period_days pre-configured in the Paddle dashboard.
  // If set, eligible users will be sent to this price for the trial checkout instead of the
  // regular monthly price, giving Paddle-native trial-to-paid auto-conversion.
  paddleTrialPriceId?: string;
}

/** Parse a positive integer env var with a fallback default. */
const envInt = (key: string, fallback: number): number => {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Default trial length (days) — 0 means no free trial. */
const DEFAULT_TRIAL_DAYS = envInt('TRIAL_DAYS_DEFAULT', 0);
const DEFAULT_STARTER_RESULT_LIMIT = envInt('STARTER_RESULT_VIEW_LIMIT', 1000);
const DEFAULT_PRO_RESULT_LIMIT = envInt('PRO_RESULT_VIEW_LIMIT', 5000);
const DEFAULT_PREMIUM_RESULT_LIMIT = envInt('PREMIUM_RESULT_VIEW_LIMIT', 0);

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    tier: 'starter',
    name: 'Starter',
    imageUploadLimit: 10,
    resultViewLimit: DEFAULT_STARTER_RESULT_LIMIT,
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
    pricing: { monthly: 6.62, annual: 5.30 },
    trialDays: envInt('TRIAL_DAYS_STARTER', DEFAULT_TRIAL_DAYS),
    paddleMonthlyPriceId: process.env.PADDLE_STARTER_MONTHLY_PRICE_ID,
    paddleAnnualPriceId:  process.env.PADDLE_STARTER_ANNUAL_PRICE_ID,
    paddleTrialPriceId:   process.env.PADDLE_STARTER_TRIAL_PRICE_ID,
  },
  {
    tier: 'pro',
    name: 'Pro',
    imageUploadLimit: 50,
    resultViewLimit: DEFAULT_PRO_RESULT_LIMIT,
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
    pricing: { monthly: 19.39, annual: 13.57 },
    trialDays: envInt('TRIAL_DAYS_PRO', DEFAULT_TRIAL_DAYS),
    paddleMonthlyPriceId: process.env.PADDLE_PRO_MONTHLY_PRICE_ID,
    paddleAnnualPriceId:  process.env.PADDLE_PRO_ANNUAL_PRICE_ID,
    paddleTrialPriceId:   process.env.PADDLE_PRO_TRIAL_PRICE_ID,
  },
  {
    tier: 'premium',
    name: 'Premium',
    imageUploadLimit: 100,
    resultViewLimit: DEFAULT_PREMIUM_RESULT_LIMIT,
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
    pricing: { monthly: 32.77, annual: 25.36 },
    trialDays: envInt('TRIAL_DAYS_PREMIUM', DEFAULT_TRIAL_DAYS),
    paddleMonthlyPriceId: process.env.PADDLE_PREMIUM_MONTHLY_PRICE_ID,
    paddleAnnualPriceId:  process.env.PADDLE_PREMIUM_ANNUAL_PRICE_ID,
    paddleTrialPriceId:   process.env.PADDLE_PREMIUM_TRIAL_PRICE_ID,
  },
];

export const getPlanDefinition = (tier: PlanTier): PlanDefinition =>
  PLAN_DEFINITIONS.find((p) => p.tier === tier) ?? PLAN_DEFINITIONS[0];
