import { XXSubscription } from '../../models/xxsubscription';
import { xxPatchPaddleSubscriptionPlan } from './xxpaddle.service';
import { xxApplyEntitlementsForSubscription, xxNotifyUser } from './xxbilling.service';
import { getXXPlanDefinition } from './xxbilling.constants';
import { xxLogBilling } from './xxbilling.logger';

const WORKER_INTERVAL_MS = parseInt(process.env.PENDING_PLAN_CHANGE_SYNC_INTERVAL_MS ?? '', 10) || 10 * 60 * 1000;
const APPLY_LOOKAHEAD_MS = parseInt(process.env.PENDING_PLAN_CHANGE_APPLY_LOOKAHEAD_MS ?? '', 10) || 30 * 60 * 1000;

async function xxProcessPendingPlanChanges(): Promise<void> {
  const now = Date.now();
  const subscriptions = await XXSubscription.find({
    status: { $in: ['active', 'trialing', 'past_due'] },
    autoRenewEnabled: true,
    paddleSubscriptionId: { $exists: true, $ne: null },
    $or: [
      { nextPlanTier: { $exists: true, $ne: null } },
      { nextBillingCycle: { $exists: true, $ne: null } },
    ],
  });

  for (const sub of subscriptions) {
    if (sub.cancelDate || !sub.paddleSubscriptionId) continue;

    const effectiveAt = sub.nextBillingDate ?? sub.currentPeriodEnd;
    if (!effectiveAt) continue;
    const msUntilEffective = effectiveAt.getTime() - now;
    if (msUntilEffective > APPLY_LOOKAHEAD_MS) continue;

    const nextTier = sub.nextPlanTier ?? sub.planTier;
    const nextCycle = sub.nextBillingCycle ?? sub.billingCycle;

    try {
      await xxPatchPaddleSubscriptionPlan(sub.paddleSubscriptionId, nextTier, nextCycle);

      if (msUntilEffective > 0) {
        await xxLogBilling({
          userId: String(sub.userId),
          event: 'scheduled_plan_change_prepared',
          source: 'worker',
          message: `Prepared Paddle renewal items for ${nextTier} (${nextCycle}); local access will change at period end.`,
          paddleSubscriptionId: sub.paddleSubscriptionId,
          metadata: { nextTier, nextCycle, effectiveAt, msUntilEffective },
        });
        continue;
      }

      sub.planTier = nextTier;
      sub.billingCycle = nextCycle;
      sub.nextPlanTier = undefined;
      sub.nextBillingCycle = undefined;
      await sub.save();
      await xxApplyEntitlementsForSubscription(sub, 'scheduled plan change');

      const plan = getXXPlanDefinition(nextTier);
      await Promise.all([
        xxNotifyUser(String(sub.userId), `Your scheduled plan change to ${plan.name} (${nextCycle}) is now active.`),
        xxLogBilling({
          userId: String(sub.userId),
          event: 'scheduled_plan_change_applied',
          source: 'worker',
          message: `Applied scheduled plan change to ${nextTier} (${nextCycle}).`,
          paddleSubscriptionId: sub.paddleSubscriptionId,
          metadata: { nextTier, nextCycle, effectiveAt },
        }),
      ]);
    } catch (error: any) {
      await xxLogBilling({
        userId: String(sub.userId),
        event: 'scheduled_plan_change_failed',
        source: 'worker',
        level: 'error',
        message: error?.message || 'Failed to apply scheduled plan change.',
        paddleSubscriptionId: sub.paddleSubscriptionId,
        metadata: { nextTier, nextCycle, effectiveAt },
      });
    }
  }
}

export function startXXPendingPlanChangeWorker(): void {
  console.log(`[XXPendingPlanChange] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min, lookahead: ${APPLY_LOOKAHEAD_MS / 60_000} min)`);
  xxProcessPendingPlanChanges().catch((err) => console.error('[XXPendingPlanChange] Startup error:', err));
  setInterval(() => {
    xxProcessPendingPlanChanges().catch((err) => console.error('[XXPendingPlanChange] Error:', err));
  }, WORKER_INTERVAL_MS);
}
