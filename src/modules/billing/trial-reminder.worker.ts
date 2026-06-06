import { createUserAlert } from '../../common/helpers/alert.helper';
import { Subscription } from '../../models/subscriptions';
import { User } from '../../models/users';
import { sendTrialEndingReminderEmail } from '../notifications/notification-email.service';

const WORKER_INTERVAL_MS = parseInt(process.env.TRIAL_REMINDER_INTERVAL_MS ?? '', 10) || 12 * 60 * 60 * 1000;
const REMINDER_STAGES = [7, 3, 1] as const;

const getDaysLeft = (endDate: Date) => {
  const diff = endDate.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
};

const pickReminderStage = (daysLeft: number, sentStages: number[]) => {
  const eligible = REMINDER_STAGES.filter((stage) => daysLeft <= stage && !sentStages.includes(stage));
  if (eligible.length === 0) {
    return null;
  }

  return Math.min(...eligible);
};

async function processTrialReminders(): Promise<void> {
  const trialingSubscriptions = await Subscription.find({
    status: 'trialing',
    grantSource: 'trial',
  })
    .select('userId trialEndDate currentPeriodEnd trialReminderStages')
    .lean();

  if (trialingSubscriptions.length === 0) {
    return;
  }

  const uniqueUserIds = [...new Set(trialingSubscriptions.map((sub) => String(sub.userId)))];
  const users = await User.find({ _id: { $in: uniqueUserIds } })
    .select('email notificationSettings.emailEnabled')
    .lean();
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  for (const subscription of trialingSubscriptions) {
    const trialEndDateRaw = subscription.trialEndDate || subscription.currentPeriodEnd;
    if (!trialEndDateRaw) {
      continue;
    }

    const trialEndDate = new Date(trialEndDateRaw);
    if (Number.isNaN(trialEndDate.getTime()) || trialEndDate.getTime() <= Date.now()) {
      continue;
    }

    const daysLeft = getDaysLeft(trialEndDate);
    const sentStages = Array.isArray(subscription.trialReminderStages)
      ? subscription.trialReminderStages
      : [];

    if (daysLeft > 7) {
      if (sentStages.length > 0) {
        await Subscription.updateOne({ _id: subscription._id }, { $set: { trialReminderStages: [] } });
      }
      continue;
    }

    const stage = pickReminderStage(daysLeft, sentStages);
    if (!stage) {
      continue;
    }

    const user = usersById.get(String(subscription.userId));
    const emailEnabled = user?.notificationSettings?.emailEnabled ?? true;
    const manageUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/user/billing`
      : undefined;

    try {
      if (user?.email && emailEnabled) {
        await sendTrialEndingReminderEmail(user.email, {
          daysLeft,
          trialEndDate,
          manageUrl,
        });
      }

      await Promise.all([
        Subscription.updateOne(
          { _id: subscription._id },
          { $addToSet: { trialReminderStages: stage } },
        ),
        createUserAlert(String(subscription.userId), {
          title: `Your free trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Upgrade to keep access.`,
          type: 'billing',
          actionUrl: '/user/billing',
        }),
      ]);
    } catch (error) {
      console.error('[TrialReminder] Failed to send reminder:', error);
    }
  }
}

export function startTrialReminderWorker(): void {
  console.log(`[TrialReminder] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  processTrialReminders().catch((err) => console.error('[TrialReminder] Error on startup run:', err));
  setInterval(() => {
    processTrialReminders().catch((err) => console.error('[TrialReminder] Error:', err));
  }, WORKER_INTERVAL_MS);
}
