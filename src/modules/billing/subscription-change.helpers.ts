import type { PlanTier } from '../../models/plan';
import type { SubscriptionStatus } from '../../models/subscriptions';

const ACCESS_STATUSES = new Set<SubscriptionStatus>(['active', 'trialing', 'past_due']);

const PLAN_TIER_RANK: Record<PlanTier, number> = {
  starter: 0,
  pro: 1,
  premium: 2,
};

const asTimestamp = (value?: Date | string | null): number => {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

export const isTierDowngrade = (
  currentTier?: PlanTier | null,
  nextTier?: PlanTier | null,
): boolean => {
  if (!currentTier || !nextTier) return false;
  return PLAN_TIER_RANK[nextTier] < PLAN_TIER_RANK[currentTier];
};

export const isTierUpgrade = (
  currentTier?: PlanTier | null,
  nextTier?: PlanTier | null,
): boolean => {
  if (!currentTier || !nextTier) return false;
  return PLAN_TIER_RANK[nextTier] > PLAN_TIER_RANK[currentTier];
};

export const didBillingPeriodAdvance = (
  previousPeriodEnd?: Date | string | null,
  nextPeriodEnd?: Date | string | null,
  toleranceMs = 60_000,
): boolean => {
  const previousTs = asTimestamp(previousPeriodEnd);
  const nextTs = asTimestamp(nextPeriodEnd);

  if (!previousTs || !nextTs) return false;
  return nextTs > previousTs + toleranceMs;
};

export const shouldTopUpBalanceOnSubscriptionUpdate = ({
  previousStatus,
  nextStatus,
  previousPeriodEnd,
  nextPeriodEnd,
  previousTier,
  nextTier,
}: {
  previousStatus?: SubscriptionStatus | null;
  nextStatus: SubscriptionStatus;
  previousPeriodEnd?: Date | string | null;
  nextPeriodEnd?: Date | string | null;
  previousTier?: PlanTier | null;
  nextTier?: PlanTier | null;
}): boolean => {
  if (nextStatus !== 'active') {
    return false;
  }

  const previouslyHadAccess = previousStatus ? ACCESS_STATUSES.has(previousStatus) : false;
  if (!previouslyHadAccess) {
    return true;
  }

  if (didBillingPeriodAdvance(previousPeriodEnd, nextPeriodEnd)) {
    return true;
  }

  return isTierUpgrade(previousTier, nextTier);
};