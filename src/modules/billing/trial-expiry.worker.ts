/**
 * Trial Expiry Worker
 *
 * Runs every hour and marks any local trial/referral/trialing subscriptions
 * whose currentPeriodEnd (or trialEndDate) has passed as 'expired', then
 * revokes the user's subscriptionId so access is cut off immediately.
 *
 * Paddle-managed trialing subscriptions are NOT touched here — Paddle fires
 * subscription.activated (paid conversion) or subscription.canceled
 * (trial cancelled) webhooks, which are the authoritative source of truth.
 */

import { Subscription } from '../../models/subscriptions';
import { User } from '../../models/users';
import { createUserAlert } from '../../common/helpers/alert.helper';

/** How often (ms) to check for expired trials. Default: 1 hour. */
const WORKER_INTERVAL_MS = parseInt(process.env.TRIAL_EXPIRY_INTERVAL_MS ?? '', 10) || 60 * 60 * 1000;

async function expireTrials(): Promise<void> {
  const now = new Date();

  // Find all local trial/referral subs that have passed their period end.
  // We intentionally skip Paddle-managed trialing subs (they have paddleSubscriptionId).
  const expired = await Subscription.find({
    status: { $in: ['active', 'trialing'] },
    grantSource: { $in: ['trial', 'referral'] },
    paddleSubscriptionId: { $exists: false },   // not Paddle-managed
    currentPeriodEnd: { $lt: now },
  }).lean();

  if (expired.length === 0) return;

  console.log(`[TrialExpiry] Expiring ${expired.length} trial subscription(s).`);

  const ids  = expired.map((s) => (s as any)._id);
  const uids = expired.map((s) => String(s.userId));

  await Promise.all([
    Subscription.updateMany({ _id: { $in: ids } }, { status: 'expired' }),
    User.updateMany({ _id: { $in: uids } }, { subscriptionId: null }),
    ...uids.map((uid) =>
      createUserAlert(uid, {
        title: 'Your free trial has ended. Upgrade to continue using the service.',
        type: 'system',
      }),
    ),
  ]);
}

export function startTrialExpiryWorker(): void {
  console.log(`[TrialExpiry] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  // Run once immediately on startup to catch any subs that expired while server was down.
  expireTrials().catch((err) => console.error('[TrialExpiry] Error on startup run:', err));
  setInterval(() => {
    expireTrials().catch((err) => console.error('[TrialExpiry] Error:', err));
  }, WORKER_INTERVAL_MS);
}
