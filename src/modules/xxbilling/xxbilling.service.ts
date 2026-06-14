import { Types } from 'mongoose';
import { User } from '../../models/users';
import { XXPlan, type XXBillingCycle, type XXPlanTier } from '../../models/xxplan';
import {
  XXSubscription,
  type IXXSubscription,
  type XXGrantSource,
  type XXSubscriptionStatus,
} from '../../models/xxsubscription';
import { createUserAlert, topUpAlerts, topUpCredits } from '../../common/helpers/alert.helper';
import {
  XX_PLAN_DEFINITIONS,
  XX_TRIAL_DAYS,
  getXXPlanDefinition,
  type XXPlanDefinition,
} from './xxbilling.constants';
import { xxLogBilling } from './xxbilling.logger';

const ACCESS_STATUSES = new Set<XXSubscriptionStatus>(['active', 'trialing', 'past_due']);
const TIER_RANK: Record<XXPlanTier, number> = { starter: 0, pro: 1, premium: 2 };

export type XXAccessEvaluation = {
  effectiveStatus: XXSubscriptionStatus | null;
  hasAccess: boolean;
  grantSource: XXGrantSource;
  periodExpired: boolean;
  isTrialing: boolean;
  trialEndsAt: Date | null;
};

const asDate = (value?: Date | string | null): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const asTimestamp = (value?: Date | string | null): number => asDate(value)?.getTime() ?? 0;

export const xxIsPaddlePriceId = (value: string) => /^pri_[a-z\d]{26}$/i.test(value.trim());

export const xxAddDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export const xxIsTierUpgrade = (from?: XXPlanTier | null, to?: XXPlanTier | null): boolean =>
  !!from && !!to && TIER_RANK[to] > TIER_RANK[from];

export const xxIsTierDowngrade = (from?: XXPlanTier | null, to?: XXPlanTier | null): boolean =>
  !!from && !!to && TIER_RANK[to] < TIER_RANK[from];

export const xxEvaluateSubscriptionAccess = (
  sub: Partial<IXXSubscription> | null | undefined,
  userSubscriptionStatus?: string | null,
  now: Date = new Date(),
): XXAccessEvaluation => {
  const rawStatus = (sub?.status ?? userSubscriptionStatus ?? null) as XXSubscriptionStatus | null;
  const grantSource = (sub?.grantSource ?? 'paid') as XXGrantSource;
  const periodEnd = asDate(sub?.currentPeriodEnd);
  const periodExpired = !!periodEnd && periodEnd.getTime() <= now.getTime();
  const localGrant = !!sub && !sub.paddleSubscriptionId && (grantSource === 'trial' || grantSource === 'referral');

  const effectiveStatus: XXSubscriptionStatus | null =
    localGrant && periodExpired && (rawStatus === 'active' || rawStatus === 'trialing')
      ? 'expired'
      : rawStatus;

  return {
    effectiveStatus,
    hasAccess: !!effectiveStatus && ACCESS_STATUSES.has(effectiveStatus),
    grantSource,
    periodExpired,
    isTrialing: effectiveStatus === 'trialing',
    trialEndsAt: effectiveStatus === 'trialing'
      ? (asDate(sub?.trialEndDate) ?? periodEnd)
      : null,
  };
};

export const xxPickEffectiveSubscription = <T extends Partial<IXXSubscription>>(
  subscriptions: T[] | null | undefined,
  preferredPaddleSubscriptionId?: string | null,
): T | null => {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;

  const STATUS_PRIORITY: Record<string, number> = {
    active: 0,
    trialing: 1,
    past_due: 2,
    paused: 3,
    pending: 4,
    cancelled: 5,
    expired: 6,
  };

  return [...subscriptions].sort((left, right) => {
    const leftEval = xxEvaluateSubscriptionAccess(left);
    const rightEval = xxEvaluateSubscriptionAccess(right);
    const leftRank = STATUS_PRIORITY[leftEval.effectiveStatus ?? left.status ?? 'expired'] ?? 99;
    const rightRank = STATUS_PRIORITY[rightEval.effectiveStatus ?? right.status ?? 'expired'] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftPreferred = preferredPaddleSubscriptionId && left.paddleSubscriptionId === preferredPaddleSubscriptionId ? 0 : 1;
    const rightPreferred = preferredPaddleSubscriptionId && right.paddleSubscriptionId === preferredPaddleSubscriptionId ? 0 : 1;
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;

    const periodDiff = asTimestamp(right.currentPeriodEnd) - asTimestamp(left.currentPeriodEnd);
    if (periodDiff !== 0) return periodDiff;

    const activationDiff = asTimestamp(right.activationDate) - asTimestamp(left.activationDate);
    if (activationDiff !== 0) return activationDiff;

    return asTimestamp((right as any).createdAt) - asTimestamp((left as any).createdAt);
  })[0] ?? null;
};

export const xxSyncPlanCatalogFromEnv = async () => {
  const plans = await Promise.all(
    XX_PLAN_DEFINITIONS.map((definition) =>
      XXPlan.findOneAndUpdate(
        { tier: definition.tier },
        {
          $set: {
            name: definition.name,
            contentsMonitored: definition.contentsMonitored,
            imageUploadLimit: definition.imageUploadLimit,
            resultViewLimit: definition.resultViewLimit,
            alertLimit: definition.alertLimit,
            pdfEnabled: definition.pdfEnabled,
            weeklyEmailAlerts: definition.weeklyEmailAlerts,
            monthlyPrice: definition.pricing.monthly,
            annualPrice: definition.pricing.annual,
            annualTotal: definition.pricing.annualTotal,
            annualDiscountPercent: definition.pricing.annualDiscountPercent,
            costPerItemYearly: definition.costPerItemYearly,
            trialDays: definition.trialDays,
            features: definition.features,
            ...(definition.paddleMonthlyPriceId ? { paddleMonthlyPriceId: definition.paddleMonthlyPriceId } : {}),
            ...(definition.paddleAnnualPriceId ? { paddleAnnualPriceId: definition.paddleAnnualPriceId } : {}),
          },
          $unset: {
            ...(!definition.paddleMonthlyPriceId ? { paddleMonthlyPriceId: '' } : {}),
            ...(!definition.paddleAnnualPriceId ? { paddleAnnualPriceId: '' } : {}),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ),
    ),
  );

  await xxLogBilling({
    event: 'plan_catalog_synced',
    source: 'worker',
    message: `Synced ${plans.length} xx billing plan(s).`,
  });

  return plans;
};

export const xxGetEffectiveSubscriptionForUser = async (
  userId: string,
  statuses?: XXSubscriptionStatus[],
) => {
  const filter: Record<string, any> = { userId };
  if (statuses?.length) filter.status = { $in: statuses };

  const [subscriptions, user] = await Promise.all([
    XXSubscription.find(filter).sort({ activationDate: -1, createdAt: -1 }).lean(),
    User.findById(userId).select('paddleSubscriptionId').lean(),
  ]);

  return xxPickEffectiveSubscription(subscriptions as any[], (user as any)?.paddleSubscriptionId ?? null);
};

export const xxGrantEntitlements = async (
  userId: string,
  plan: XXPlanDefinition,
  grantKey?: string,
) => {
  if (grantKey) {
    const alreadyGranted = await XXSubscription.exists({ userId, lastEntitlementGrantKey: grantKey });
    if (alreadyGranted) return;
  }

  // alertLimit === 0 is the "unlimited" sentinel in plan definitions.
  // topUpAlerts expects -1 for unlimited; pass it through correctly.
  const alertQuota = plan.alertLimit === 0 ? -1 : plan.alertLimit;
  await Promise.all([
    topUpCredits(userId, plan.imageUploadLimit),
    topUpAlerts(userId, alertQuota),
  ]);
};

const xxSetUserSubscription = async (
  userId: string,
  sub: IXXSubscription | null,
  status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused',
) => {
  await User.findByIdAndUpdate(userId, {
    subscriptionId: sub?._id ?? null,
    paddleSubscriptionId: sub?.paddleSubscriptionId ?? undefined,
    paddleCustomerId: sub?.paddleCustomerId ?? undefined,
    ...(status ? { subscriptionStatus: status } : {}),
  });
};

export const xxGrantPlanForDays = async ({
  userId,
  tier,
  days,
  grantSource,
  extendExisting = false,
  logPrefix,
}: {
  userId: string;
  tier: XXPlanTier;
  days: number;
  grantSource: XXGrantSource;
  extendExisting?: boolean;
  logPrefix: string;
}) => {
  const plan = getXXPlanDefinition(tier);
  const now = new Date();
  const active = await xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'past_due']);

  if (extendExisting && active) {
    const base = asDate(active.currentPeriodEnd) ?? now;
    const currentPeriodEnd = xxAddDays(base.getTime() > now.getTime() ? base : now, days);
    const updated = await XXSubscription.findByIdAndUpdate(
      (active as any)._id,
      {
        $set: {
          currentPeriodEnd,
          nextBillingDate: currentPeriodEnd,
          ...(grantSource === 'trial' ? { trialEndDate: currentPeriodEnd, trialReminderStages: [] } : {}),
        },
      },
      { new: true },
    );

    const grantKey = `${grantSource}:${tier}:extend:${currentPeriodEnd.toISOString()}`;
    await xxGrantEntitlements(userId, plan, grantKey);
    await XXSubscription.findByIdAndUpdate((active as any)._id, { lastEntitlementGrantKey: grantKey });
    await xxLogBilling({
      userId,
      event: 'grant_extended',
      source: 'reward',
      message: `${logPrefix}: extended ${tier} access by ${days} day(s).`,
      metadata: { tier, days, grantSource, currentPeriodEnd },
    });
    return updated;
  }

  await XXSubscription.updateMany(
    {
      userId,
      status: { $in: ['active', 'trialing', 'pending', 'past_due'] },
      paddleSubscriptionId: { $exists: false },
    },
    { $set: { status: 'cancelled', cancelDate: now, autoRenewEnabled: false } },
  );

  const currentPeriodEnd = xxAddDays(now, days);
  const sub = await XXSubscription.create({
    userId: new Types.ObjectId(userId),
    planTier: tier,
    billingCycle: 'monthly',
    grantSource,
    status: grantSource === 'trial' ? 'trialing' : 'active',
    activationDate: now,
    currentPeriodEnd,
    nextBillingDate: currentPeriodEnd,
    trialEndDate: grantSource === 'trial' ? currentPeriodEnd : undefined,
    autoRenewEnabled: false,
  });

  const grantKey = `${grantSource}:${tier}:create:${currentPeriodEnd.toISOString()}`;
  await Promise.all([
    xxSetUserSubscription(userId, sub, grantSource === 'trial' ? 'trialing' : 'active'),
    xxGrantEntitlements(userId, plan, grantKey).then(() =>
      XXSubscription.findByIdAndUpdate(sub._id, { lastEntitlementGrantKey: grantKey }),
    ),
    createUserAlert(userId, {
      title: grantSource === 'trial'
        ? `Your ${plan.name} free trial has started for ${days} day(s).`
        : `Your ${plan.name} reward access has started.`,
      type: 'billing',
      actionUrl: '/user/billing',
      metadata: { tier, grantSource, currentPeriodEnd },
    }),
  ]);

  await xxLogBilling({
    userId,
    event: 'grant_created',
    source: 'reward',
    message: `${logPrefix}: granted ${tier} access for ${days} day(s).`,
    metadata: { tier, days, grantSource, currentPeriodEnd },
  });

  return sub;
};

export const xxGrantLoginProAccess = async (userId: string) => {
  const existing = await XXSubscription.findOne({ userId }).select('_id').lean();
  if (existing) return;

  await xxGrantPlanForDays({
    userId,
    tier: 'pro',
    days: XX_TRIAL_DAYS,
    grantSource: 'trial',
    logPrefix: '[xx login]',
  });
};

export const xxGrantFreeMonthPremium = async (userId: string) => {
  await xxGrantPlanForDays({
    userId,
    tier: 'premium',
    days: 30,
    grantSource: 'referral',
    logPrefix: '[xx referral]',
  });
};

export const xxExtendOrGrantProReward = async (userId: string, days: number) => {
  await xxGrantPlanForDays({
    userId,
    tier: 'pro',
    days,
    grantSource: 'referral',
    extendExisting: true,
    logPrefix: '[xx referral milestone]',
  });
};

export const xxPlanForSubscription = (sub: Partial<IXXSubscription> | null | undefined) =>
  getXXPlanDefinition((sub?.planTier as XXPlanTier | undefined) ?? 'starter');

export const xxApplyEntitlementsForSubscription = async (
  sub: IXXSubscription,
  reason: string,
) => {
  const plan = getXXPlanDefinition(sub.planTier);
  const periodKey = sub.currentPeriodEnd?.toISOString() ?? new Date().toISOString();
  const grantKey = `${sub.paddleSubscriptionId ?? sub._id}:${sub.planTier}:${sub.billingCycle}:${periodKey}`;

  if (sub.lastEntitlementGrantKey === grantKey) return;

  await xxGrantEntitlements(String(sub.userId), plan);
  sub.lastEntitlementGrantKey = grantKey;
  await sub.save();

  await xxLogBilling({
    userId: String(sub.userId),
    event: 'entitlements_granted',
    source: 'paddle',
    message: `Added ${plan.imageUploadLimit} monitor credits and ${plan.alertLimit || 'unlimited'} alerts (${reason}).`,
    paddleSubscriptionId: sub.paddleSubscriptionId,
    metadata: { tier: sub.planTier, billingCycle: sub.billingCycle, reason, grantKey },
  });
};

export const xxMapStatusToUserStatus = (
  status: XXSubscriptionStatus,
): 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused' | undefined => {
  if (status === 'cancelled' || status === 'expired') return 'canceled';
  if (status === 'active' || status === 'trialing' || status === 'past_due' || status === 'paused') return status;
  return undefined;
};

export const xxNotifyUser = async (
  userId: string,
  title: string,
  metadata?: Record<string, any>,
) => {
  await createUserAlert(userId, {
    title,
    type: 'billing',
    actionUrl: '/user/billing',
    metadata,
  });
};
