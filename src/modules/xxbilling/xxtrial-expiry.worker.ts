import { User } from '../../models/users';
import { XXSubscription } from '../../models/xxsubscription';
import { xxNotifyUser, xxApplyEntitlementsForSubscription } from './xxbilling.service';
import { xxLogBilling } from './xxbilling.logger';
import { getXXPlanDefinition } from './xxbilling.constants';
import { syncUserSubscriptionPointerFromWorker } from './xxpaddle.service';

const WORKER_INTERVAL_MS = parseInt(process.env.TRIAL_EXPIRY_INTERVAL_MS ?? '', 10) || 60 * 60 * 1000;

async function xxExpireTrials(): Promise<void> {
  const now = new Date();
  const expired = await XXSubscription.find({
    status: { $in: ['active', 'trialing'] },
    grantSource: { $in: ['trial', 'referral'] },
    paddleSubscriptionId: { $exists: false },
    currentPeriodEnd: { $lt: now },
  }).lean();

  if (expired.length === 0) return;

  const ids = expired.map((sub) => sub._id);
  const userIds = expired.map((sub) => String(sub.userId));

  await Promise.all([
    XXSubscription.updateMany({ _id: { $in: ids } }, { $set: { status: 'expired', autoRenewEnabled: false } }),
    xxLogBilling({
      event: 'local_grants_expired',
      source: 'worker',
      message: `Expired ${expired.length} local xx billing grant(s).`,
      metadata: { count: expired.length },
    }),
  ]);

  // For each expired trial, check whether the user has a deferred Paddle subscription
  // (purchased at a lower tier while trialling). If so, activate it now instead of
  // pointing the user to a bare "subscribe" prompt.
  for (const expiredSub of expired) {
    const userId = String(expiredSub.userId);

    const deferred = await XXSubscription.findOne({
      userId,
      status: 'pending',
      paddleSubscriptionId: { $exists: true, $ne: null },
      deferredActivationDate: { $lte: now },
    });

    if (deferred) {
      // Activate the deferred paid subscription.
      // currentPeriodEnd was already stored as (trialEnd + billingPeriodLength) during
      // the deferred upsert, so it is already correct — no recalculation needed.
      deferred.status = 'active';
      deferred.activationDate = now;
      deferred.deferredActivationDate = undefined;
      await deferred.save();

      await syncUserSubscriptionPointerFromWorker(deferred);
      await xxApplyEntitlementsForSubscription(deferred, 'deferred downgrade activation after trial');

      const plan = getXXPlanDefinition(deferred.planTier);
      await Promise.all([
        xxNotifyUser(
          userId,
          `Your free trial has ended. Your ${plan.name} (${deferred.billingCycle}) plan is now active.`,
          { tier: deferred.planTier, billingCycle: deferred.billingCycle },
        ),
        xxLogBilling({
          userId,
          event: 'deferred_downgrade_activated',
          source: 'worker',
          message: `Activated deferred ${deferred.planTier} (${deferred.billingCycle}) subscription after trial expiry.`,
          paddleSubscriptionId: deferred.paddleSubscriptionId,
          metadata: { tier: deferred.planTier, billingCycle: deferred.billingCycle },
        }),
      ]);
    } else {
      // No deferred subscription: user's access simply ends; prompt them to subscribe.
      await Promise.all([
        User.findByIdAndUpdate(userId, { $set: { subscriptionId: null, subscriptionStatus: 'canceled' } }),
        xxNotifyUser(userId, 'Your free access period has ended. Subscribe to continue using the service.'),
      ]);
    }
  }
}

export function startXXTrialExpiryWorker(): void {
  console.log(`[XXTrialExpiry] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  xxExpireTrials().catch((err) => console.error('[XXTrialExpiry] Startup error:', err));
  setInterval(() => {
    xxExpireTrials().catch((err) => console.error('[XXTrialExpiry] Error:', err));
  }, WORKER_INTERVAL_MS);
}
