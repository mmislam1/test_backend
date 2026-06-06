import type { SubscriptionStatus } from '../../models/subscriptions';

type GrantSource = 'trial' | 'referral' | 'paid';

export type SubscriptionAccessLike = {
  status?: SubscriptionStatus | string | null;
  grantSource?: GrantSource | string | null;
  currentPeriodEnd?: Date | string | null;
  trialEndDate?: Date | string | null;
  paddleSubscriptionId?: string | null;
};

const ACCESS_STATUSES = new Set<SubscriptionStatus>(['active', 'trialing', 'past_due']);

export type SubscriptionAccessEvaluation = {
  effectiveStatus: SubscriptionStatus | null;
  hasAccess: boolean;
  grantSource: GrantSource;
  periodExpired: boolean;
  isLocalTrialOrReferral: boolean;
  isTrialing: boolean;
  trialEndsAt: Date | null;
};

export type SubscriptionCandidateLike = SubscriptionAccessLike & {
  _id?: unknown;
  activationDate?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const asTimestamp = (value: Date | string | null | undefined): number =>
  asDate(value)?.getTime() ?? 0;

const normalizeId = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String((value as { toString(): string }).toString());
  }
  return '';
};

const matchesPreferredSubscription = (
  candidate: SubscriptionCandidateLike,
  preferredSubscriptionId: string,
): boolean => {
  if (!preferredSubscriptionId) {
    return false;
  }

  return [normalizeId(candidate._id), normalizeId(candidate.paddleSubscriptionId)].includes(
    preferredSubscriptionId,
  );
};

export const evaluateSubscriptionAccess = (
  sub: SubscriptionAccessLike | null | undefined,
  userSubscriptionStatus?: string | null,
  now: Date = new Date(),
): SubscriptionAccessEvaluation => {
  const rawStatus = (sub?.status ?? userSubscriptionStatus ?? null) as SubscriptionStatus | null;
  const grantSource = ((sub?.grantSource ?? 'paid') as GrantSource) || 'paid';
  const currentPeriodEnd = asDate(sub?.currentPeriodEnd);

  const isLocalTrialOrReferral =
    !!sub &&
    !sub.paddleSubscriptionId &&
    (grantSource === 'trial' || grantSource === 'referral');

  const periodExpired = !!currentPeriodEnd && currentPeriodEnd.getTime() <= now.getTime();

  const effectiveStatus: SubscriptionStatus | null =
    isLocalTrialOrReferral &&
    periodExpired &&
    (rawStatus === 'active' || rawStatus === 'trialing')
      ? 'expired'
      : rawStatus;

  const hasAccess = !!effectiveStatus && ACCESS_STATUSES.has(effectiveStatus);
  const isTrialing = effectiveStatus === 'trialing';
  const trialEndsAt = isTrialing
    ? (asDate(sub?.trialEndDate) ?? currentPeriodEnd)
    : null;

  return {
    effectiveStatus,
    hasAccess,
    grantSource,
    periodExpired,
    isLocalTrialOrReferral,
    isTrialing,
    trialEndsAt,
  };
};

export const pickEffectiveSubscription = <T extends SubscriptionCandidateLike>(
  subscriptions: T[] | null | undefined,
  options: {
    preferredSubscriptionId?: unknown;
    now?: Date;
  } = {},
): T | null => {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return null;
  }

  const now = options.now ?? new Date();
  const preferredSubscriptionId = normalizeId(options.preferredSubscriptionId);
  const STATUS_PRIORITY: Record<string, number> = {
    active: 0,
    trialing: 1,
    past_due: 2,
    paused: 3,
    pending: 4,
    cancelled: 5,
    canceled: 5,
    expired: 6,
  };

  return [...subscriptions].sort((left, right) => {
    const leftEval = evaluateSubscriptionAccess(left, null, now);
    const rightEval = evaluateSubscriptionAccess(right, null, now);

    const leftStatusRank = STATUS_PRIORITY[leftEval.effectiveStatus ?? left.status ?? 'expired'] ?? 99;
    const rightStatusRank = STATUS_PRIORITY[rightEval.effectiveStatus ?? right.status ?? 'expired'] ?? 99;
    if (leftStatusRank !== rightStatusRank) {
      return leftStatusRank - rightStatusRank;
    }

    const leftPreferred = matchesPreferredSubscription(left, preferredSubscriptionId) ? 0 : 1;
    const rightPreferred = matchesPreferredSubscription(right, preferredSubscriptionId) ? 0 : 1;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }

    const leftPaddleManaged = left.paddleSubscriptionId ? 0 : 1;
    const rightPaddleManaged = right.paddleSubscriptionId ? 0 : 1;
    if (leftPaddleManaged !== rightPaddleManaged) {
      return leftPaddleManaged - rightPaddleManaged;
    }

    const periodEndDiff =
      asTimestamp(right.currentPeriodEnd) - asTimestamp(left.currentPeriodEnd);
    if (periodEndDiff !== 0) {
      return periodEndDiff;
    }

    const activationDiff = asTimestamp(right.activationDate) - asTimestamp(left.activationDate);
    if (activationDiff !== 0) {
      return activationDiff;
    }

    const updatedDiff = asTimestamp(right.updatedAt) - asTimestamp(left.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }

    return asTimestamp(right.createdAt) - asTimestamp(left.createdAt);
  })[0] ?? null;
};
