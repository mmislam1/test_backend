import { createUserAlert } from '../../common/helpers/alert.helper';
import { Subscription } from '../../models/subscriptions';
import { User } from '../../models/users';
import { sendAutoRenewOffReminderEmail } from '../notifications/notification-email.service';

const WORKER_INTERVAL_MS = parseInt(process.env.AUTO_RENEW_REMINDER_INTERVAL_MS ?? '', 10) || 12 * 60 * 60 * 1000;
const REMINDER_STAGES = [7, 5, 3] as const;

const getDaysLeft = (cancelDate: Date) => {
  const diff = cancelDate.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
};

const pickReminderStage = (daysLeft: number, sentStages: number[]) => {
  const eligible = REMINDER_STAGES.filter((stage) => daysLeft <= stage && !sentStages.includes(stage));
  if (eligible.length === 0) {
    return null;
  }

  // Send the nearest unsent checkpoint once (3, then 5, then 7 would be stale ordering).
  return Math.min(...eligible);
};

async function processAutoRenewReminders(): Promise<void> {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // If cancellation is outside the final week, clear old reminder checkpoints.
  await Subscription.updateMany(
    {
      status: { $in: ['active', 'trialing', 'past_due'] },
      paddleSubscriptionId: { $exists: true, $ne: null },
      cancelDate: { $gt: weekAhead },
      autoRenewReminderStages: { $exists: true, $ne: [] },
    },
    { $set: { autoRenewReminderStages: [] } },
  );

  const soonEndingSubscriptions = await Subscription.find({
    status: { $in: ['active', 'trialing', 'past_due'] },
    paddleSubscriptionId: { $exists: true, $ne: null },
    cancelDate: { $gt: now, $lte: weekAhead },
  })
    .select('userId cancelDate autoRenewReminderStages')
    .lean();

  if (soonEndingSubscriptions.length === 0) {
    return;
  }

  const uniqueUserIds = [...new Set(soonEndingSubscriptions.map((sub) => String(sub.userId)))];
  const users = await User.find({ _id: { $in: uniqueUserIds } })
    .select('email notificationSettings.emailEnabled')
    .lean();
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  for (const subscription of soonEndingSubscriptions) {
    if (!subscription.cancelDate) {
      continue;
    }

    const cancelDate = new Date(subscription.cancelDate);
    if (Number.isNaN(cancelDate.getTime())) {
      continue;
    }

    const daysLeft = getDaysLeft(cancelDate);
    const sentStages = Array.isArray(subscription.autoRenewReminderStages)
      ? subscription.autoRenewReminderStages
      : [];
    const stage = pickReminderStage(daysLeft, sentStages);

    if (!stage) {
      continue;
    }

    const user = usersById.get(String(subscription.userId));
    const emailEnabled = user?.notificationSettings?.emailEnabled ?? true;
    if (!user?.email || !emailEnabled) {
      continue;
    }

    const manageUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/user/billing`
      : undefined;

    try {
      await sendAutoRenewOffReminderEmail(user.email, {
        daysLeft,
        cancelDate,
        manageUrl,
      });

      await Promise.all([
        Subscription.updateOne(
          { _id: subscription._id },
          { $addToSet: { autoRenewReminderStages: stage } },
        ),
        createUserAlert(String(subscription.userId), {
          title: `Auto-renew is off. ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left before your plan ends.`,
          type: 'billing',
          actionUrl: '/user/billing',
        }),
      ]);
    } catch (error) {
      console.error('[AutoRenewReminder] Failed to send reminder email:', error);
    }
  }
}

export function startAutoRenewReminderWorker(): void {
  console.log(`[AutoRenewReminder] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  processAutoRenewReminders().catch((err) => console.error('[AutoRenewReminder] Error on startup run:', err));
  setInterval(() => {
    processAutoRenewReminders().catch((err) => console.error('[AutoRenewReminder] Error:', err));
  }, WORKER_INTERVAL_MS);
}
