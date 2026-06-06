import { Alert } from '../../models/alerts';
import { User } from '../../models/users';
import type { IAlert } from '../../models/alerts';

/** Alert types that consume the user's alertsRemaining quota. */
const QUOTA_TYPES: IAlert['type'][] = ['new_match', 'scan_update'];

/**
 * Creates a user alert while enforcing the plan's alert quota.
 *
 * - 'billing' and 'system' alerts bypass the quota and are always delivered.
 * - 'new_match' and 'scan_update' alerts are gated:
 *     - alertsRemaining === -1  → unlimited (Premium), always deliver
 *     - alertsRemaining  >  0   → deliver + deduct 1
 *     - alertsRemaining  <=  0  → quota exhausted, silently skip
 */
export const createUserAlert = async (
  userId: string,
  data: {
    title: string;
    message?: string;
    type?: IAlert['type'];
    isRead?: boolean;
    actionUrl?: string;
    metadata?: Record<string, any>;
  },
): Promise<void> => {
  if (!userId) return;

  const type = data.type ?? 'system';
  const user = await User.findById(userId)
    .select('alertsRemaining notificationSettings.inAppEnabled')
    .lean();

  if (!user) return;

  const inAppEnabled = user.notificationSettings?.inAppEnabled ?? true;
  if (!inAppEnabled) return;

  // Billing and system alerts are never quota-gated
  if (!QUOTA_TYPES.includes(type)) {
    await Alert.create({ userId, timestamp: new Date(), isRead: false, ...data });
    return;
  }

  // Discovery / scan alerts: check and deduct quota
  const remaining = user.alertsRemaining ?? 0;

  // -1 = unlimited (e.g. Premium plan)
  if (remaining === -1) {
    await Alert.create({ userId, timestamp: new Date(), isRead: false, ...data });
    return;
  }

  // Quota exhausted
  if (remaining <= 0) return;

  // Deliver and atomically deduct
  await Promise.all([
    Alert.create({ userId, timestamp: new Date(), isRead: false, ...data }),
    User.findByIdAndUpdate(userId, { $inc: { alertsRemaining: -1 } }),
  ]);
};

/**
 * Top up a user's alert quota.
 * alertLimit = 0 means the plan is unlimited → sets alertsRemaining to -1.
 * alertLimit > 0 → adds that amount to the existing balance.
 */
export const topUpAlerts = (userId: string, alertLimit: number): Promise<any> => {
  if (alertLimit === 0) {
    // Unlimited plan — use sentinel -1
    return User.findByIdAndUpdate(userId, { $set: { alertsRemaining: -1 } });
  }
  return User.findByIdAndUpdate(userId, { $inc: { alertsRemaining: alertLimit } });
};

/**
 * Top up a user's monitoring (search) credits.
 * Adds the plan's monitoring credits to the existing balance.
 * Legacy negative sentinel balances (e.g. -1) are normalized to this plan limit.
 */
export const topUpCredits = (userId: string, imageUploadLimit: number): Promise<any> => {
  const creditLimit = Math.max(0, imageUploadLimit);

  return User.findById(userId)
    .select('credits')
    .lean()
    .then((user) => {
      if (!user) return null;

      const currentCredits = Number((user as any).credits ?? 0);
      if (currentCredits < 0) {
        return User.findByIdAndUpdate(userId, { $set: { credits: creditLimit } });
      }

      return User.findByIdAndUpdate(userId, { $inc: { credits: creditLimit } });
    });
};
