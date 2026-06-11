import type { XxBillingCycle, XxPlanDefinition, XxPlanTier } from './xxbilling.types';

const priceFromEnv = (keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
};

const starterMonthlyPriceId = priceFromEnv([
  'XX_PADDLE_STARTER_MONTHLY_PRICE_ID',
  'XX_PADDLE_STANDARD_MONTHLY_PRICE_ID',
  'PADDLE_STARTER_MONTHLY_PRICE_ID',
  'PADDLE_STANDARD_MONTHLY_PRICE_ID',
]);

const starterAnnualPriceId = priceFromEnv([
  'XX_PADDLE_STARTER_ANNUAL_PRICE_ID',
  'XX_PADDLE_STANDARD_ANNUAL_PRICE_ID',
  'PADDLE_STARTER_ANNUAL_PRICE_ID',
  'PADDLE_STANDARD_ANNUAL_PRICE_ID',
]);

export const XX_PLAN_DEFINITIONS: XxPlanDefinition[] = [
  {
    tier: 'starter',
    aliases: ['starter', 'standard'],
    name: 'Starter',
    monthlyPrice: 6.6,
    annualMonthlyPrice: 5.2,
    annualTotal: 62.4,
    yearlyDiscountPercent: 20,
    monitors: 10,
    alertLimit: 1000,
    yearlyCostPerItem: 0.53,
    paddleMonthlyPriceId: starterMonthlyPriceId,
    paddleAnnualPriceId: starterAnnualPriceId,
  },
  {
    tier: 'pro',
    aliases: ['pro'],
    name: 'Pro',
    monthlyPrice: 19.3,
    annualMonthlyPrice: 13.5,
    annualTotal: 162,
    yearlyDiscountPercent: 30,
    monitors: 50,
    alertLimit: 5000,
    yearlyCostPerItem: 0.27,
    paddleMonthlyPriceId: priceFromEnv([
      'XX_PADDLE_PRO_MONTHLY_PRICE_ID',
      'PADDLE_PRO_MONTHLY_PRICE_ID',
    ]),
    paddleAnnualPriceId: priceFromEnv([
      'XX_PADDLE_PRO_ANNUAL_PRICE_ID',
      'PADDLE_PRO_ANNUAL_PRICE_ID',
    ]),
  },
  {
    tier: 'premium',
    aliases: ['premium'],
    name: 'Premium',
    monthlyPrice: 32.7,
    annualMonthlyPrice: 19.6,
    annualTotal: 235.2,
    yearlyDiscountPercent: 40,
    monitors: 100,
    alertLimit: null,
    yearlyCostPerItem: 0.2,
    paddleMonthlyPriceId: priceFromEnv([
      'XX_PADDLE_PREMIUM_MONTHLY_PRICE_ID',
      'PADDLE_PREMIUM_MONTHLY_PRICE_ID',
    ]),
    paddleAnnualPriceId: priceFromEnv([
      'XX_PADDLE_PREMIUM_ANNUAL_PRICE_ID',
      'PADDLE_PREMIUM_ANNUAL_PRICE_ID',
    ]),
  },
];

export const normalizeXxPlanTier = (value: unknown): XxPlanTier | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;

  const match = XX_PLAN_DEFINITIONS.find((plan) => plan.aliases.includes(normalized));
  return match?.tier ?? null;
};

export const normalizeXxBillingCycle = (value: unknown): XxBillingCycle | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'monthly' || normalized === 'month') return 'monthly';
  if (normalized === 'annual' || normalized === 'annually' || normalized === 'yearly' || normalized === 'year') {
    return 'annual';
  }
  return null;
};

export const getXxPlanDefinition = (tier: XxPlanTier): XxPlanDefinition => {
  const plan = XX_PLAN_DEFINITIONS.find((item) => item.tier === tier);
  if (!plan) {
    throw new Error(`Unknown xx billing plan tier: ${tier}`);
  }
  return plan;
};

export const getXxPlanPriceId = (
  tier: XxPlanTier,
  billingCycle: XxBillingCycle,
): string | undefined => {
  const plan = getXxPlanDefinition(tier);
  return billingCycle === 'annual' ? plan.paddleAnnualPriceId : plan.paddleMonthlyPriceId;
};

export const getXxPlanByPriceId = (
  priceId?: string,
): { plan: XxPlanDefinition; billingCycle: XxBillingCycle } | null => {
  if (!priceId) return null;
  for (const plan of XX_PLAN_DEFINITIONS) {
    if (plan.paddleMonthlyPriceId === priceId) {
      return { plan, billingCycle: 'monthly' };
    }
    if (plan.paddleAnnualPriceId === priceId) {
      return { plan, billingCycle: 'annual' };
    }
  }
  return null;
};

export const getXxPlanRank = (tier: XxPlanTier): number =>
  ({ starter: 1, pro: 2, premium: 3 })[tier];

export const serializeXxPlan = (plan: XxPlanDefinition) => ({
  tier: plan.tier,
  aliases: plan.aliases,
  name: plan.name,
  pricing: {
    monthly: plan.monthlyPrice,
    annualMonthly: plan.annualMonthlyPrice,
    annualTotal: plan.annualTotal,
    yearlyDiscountPercent: plan.yearlyDiscountPercent,
    yearlyCostPerItem: plan.yearlyCostPerItem,
  },
  limits: {
    contentsMonitored: plan.monitors,
    alerts: plan.alertLimit === null ? 'unlimited' : plan.alertLimit,
  },
  noRefundPolicy: true,
  paddleConfigured: {
    monthly: Boolean(plan.paddleMonthlyPriceId),
    annual: Boolean(plan.paddleAnnualPriceId),
  },
});
