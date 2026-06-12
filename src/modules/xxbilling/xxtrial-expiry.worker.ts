import { User } from '../../models/users';
import { XXSubscription } from '../../models/xxsubscription';
import { xxNotifyUser } from './xxbilling.service';
import { xxLogBilling } from './xxbilling.logger';

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
    User.updateMany({ _id: { $in: userIds } }, { $set: { subscriptionId: null, subscriptionStatus: 'canceled' } }),
    ...userIds.map((userId) =>
      xxNotifyUser(userId, 'Your free access period has ended. Subscribe to continue using the service.'),
    ),
    xxLogBilling({
      event: 'local_grants_expired',
      source: 'worker',
      message: `Expired ${expired.length} local xx billing grant(s).`,
      metadata: { count: expired.length },
    }),
  ]);
}

export function startXXTrialExpiryWorker(): void {
  console.log(`[XXTrialExpiry] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  xxExpireTrials().catch((err) => console.error('[XXTrialExpiry] Startup error:', err));
  setInterval(() => {
    xxExpireTrials().catch((err) => console.error('[XXTrialExpiry] Error:', err));
  }, WORKER_INTERVAL_MS);
}
