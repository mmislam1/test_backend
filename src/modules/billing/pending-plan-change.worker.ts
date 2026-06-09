import { Subscription, type BillingCycle } from '../../models/subscriptions';
import type { PlanTier } from '../../models/plan';
import { syncPaddleSubscriptionToPlan } from './billing.controller';

const WORKER_INTERVAL_MS = parseInt(process.env.PENDING_PLAN_CHANGE_SYNC_INTERVAL_MS ?? '', 10) || 10 * 60 * 1000;
const APPLY_LOOKAHEAD_MS = parseInt(process.env.PENDING_PLAN_CHANGE_APPLY_LOOKAHEAD_MS ?? '', 10) || 30 * 60 * 1000;

const getPlanId = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value?._id) return String(value._id);
  return String(value);
};

const getPlanTier = (value: any): PlanTier | null => {
  if (!value || typeof value !== 'object') return null;
  return (value.tier as PlanTier | undefined) ?? null;
};

const getEffectiveAt = (subscription: any): Date | null => {
  const rawValue = subscription.nextBillingDate ?? subscription.currentPeriodEnd;
  if (!rawValue) return null;

  const date = rawValue instanceof Date ? rawValue : new Date(rawValue);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hasPendingRenewalChange = ({
  currentPlanId,
  nextPlanId,
  currentBillingCycle,
  nextBillingCycle,
}: {
  currentPlanId: string | null;
  nextPlanId: string | null;
  currentBillingCycle: BillingCycle;
  nextBillingCycle: BillingCycle;
}): boolean => {
  if (nextBillingCycle !== currentBillingCycle) {
    return true;
  }

  return !!nextPlanId && !!currentPlanId && nextPlanId !== currentPlanId;
};

async function processPendingPlanChanges(): Promise<void> {
  const now = Date.now();
  const subscriptions = await Subscription.find({
    status: { $in: ['active', 'trialing', 'past_due'] },
    paddleSubscriptionId: { $exists: true, $ne: null },
    $or: [
      { nextPlanId: { $exists: true, $ne: null } },
      { nextBillingCycle: { $exists: true, $ne: null } },
    ],
  })
    .select('userId paddleSubscriptionId planId lockedPlanId nextPlanId billingCycle lockedBillingCycle nextBillingCycle nextBillingDate currentPeriodEnd cancelDate')
    .populate('planId', 'tier name')
    .populate('lockedPlanId', 'tier name')
    .populate('nextPlanId', 'tier name')
    .lean();

  for (const subscription of subscriptions) {
    if (subscription.cancelDate || !subscription.paddleSubscriptionId) {
      continue;
    }

    const currentPlanRef = (subscription as any).lockedPlanId ?? (subscription as any).planId;
    const nextPlanRef = (subscription as any).nextPlanId ?? currentPlanRef;
    const currentPlanId = getPlanId(currentPlanRef);
    const nextPlanId = getPlanId(nextPlanRef);
    const currentPlanTier = getPlanTier(currentPlanRef);
    const nextPlanTier = getPlanTier(nextPlanRef) ?? currentPlanTier;
    const currentBillingCycle = ((subscription as any).lockedBillingCycle ?? subscription.billingCycle ?? 'monthly') as BillingCycle;
    const nextBillingCycle = (subscription.nextBillingCycle ?? currentBillingCycle) as BillingCycle;

    if (!currentPlanTier || !nextPlanTier) {
      console.warn('[PendingPlanChange] Skipping subscription with unresolved plan tier.', {
        subscriptionId: subscription.paddleSubscriptionId,
        userId: String(subscription.userId),
        currentPlanId,
        nextPlanId,
      });
      continue;
    }

    if (!hasPendingRenewalChange({ currentPlanId, nextPlanId, currentBillingCycle, nextBillingCycle })) {
      continue;
    }

    const effectiveAt = getEffectiveAt(subscription);
    if (!effectiveAt) {
      console.warn('[PendingPlanChange] Skipping subscription without a valid effective date for the renewal change.', {
        subscriptionId: subscription.paddleSubscriptionId,
        userId: String(subscription.userId),
        currentPlanId,
        nextPlanId,
      });
      continue;
    }

    const msUntilEffective = effectiveAt.getTime() - now;
    const shouldApplyRenewalPlan = msUntilEffective <= APPLY_LOOKAHEAD_MS;
    const planTier = shouldApplyRenewalPlan ? nextPlanTier : currentPlanTier;
    const billingCycle = shouldApplyRenewalPlan ? nextBillingCycle : currentBillingCycle;

    try {
      const didSync = await syncPaddleSubscriptionToPlan({
        subscriptionId: String(subscription.paddleSubscriptionId),
        planTier,
        billingCycle,
      });

      if (didSync) {
        console.log('[PendingPlanChange] Synced Paddle renewal items for staged plan change.', {
          subscriptionId: subscription.paddleSubscriptionId,
          userId: String(subscription.userId),
          mode: shouldApplyRenewalPlan ? 'apply-renewal-plan' : 'preserve-current-plan',
          effectiveAt: effectiveAt.toISOString(),
          msUntilEffective,
          planTier,
          billingCycle,
        });
      }
    } catch (error) {
      console.error('[PendingPlanChange] Failed to sync Paddle renewal items.', {
        subscriptionId: subscription.paddleSubscriptionId,
        userId: String(subscription.userId),
        mode: shouldApplyRenewalPlan ? 'apply-renewal-plan' : 'preserve-current-plan',
        effectiveAt: effectiveAt.toISOString(),
        msUntilEffective,
        planTier,
        billingCycle,
        error,
      });
    }
  }
}

export function startPendingPlanChangeWorker(): void {
  console.log(`[PendingPlanChange] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min, lookahead: ${APPLY_LOOKAHEAD_MS / 60_000} min)`);
  processPendingPlanChanges().catch((err) => console.error('[PendingPlanChange] Error on startup run:', err));
  setInterval(() => {
    processPendingPlanChanges().catch((err) => console.error('[PendingPlanChange] Error:', err));
  }, WORKER_INTERVAL_MS);
}