import { User } from '../../models/users';
import { XXSubscription } from '../../models/xxsubscription';
import { sendTrialEndingReminderEmail } from '../notifications/notification-email.service';
import { xxNotifyUser } from './xxbilling.service';

const WORKER_INTERVAL_MS = parseInt(process.env.TRIAL_REMINDER_INTERVAL_MS ?? '', 10) || 12 * 60 * 60 * 1000;
const REMINDER_STAGES = [7, 3, 1] as const;

const daysLeft = (date: Date) => Math.max(0, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

async function xxProcessTrialReminders(): Promise<void> {
  const subs = await XXSubscription.find({ status: 'trialing', grantSource: 'trial' })
    .select('userId trialEndDate currentPeriodEnd trialReminderStages')
    .lean();

  for (const sub of subs) {
    const end = sub.trialEndDate ?? sub.currentPeriodEnd;
    if (!end) continue;
    const endDate = new Date(end);
    if (Number.isNaN(endDate.getTime()) || endDate.getTime() <= Date.now()) continue;

    const left = daysLeft(endDate);
    const sent = Array.isArray(sub.trialReminderStages) ? sub.trialReminderStages : [];
    const stage = Math.min(...REMINDER_STAGES.filter((item) => left <= item && !sent.includes(item)));
    if (!Number.isFinite(stage)) continue;

    const user = await User.findById(sub.userId).select('email notificationSettings.emailEnabled').lean();
    const manageUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/user/billing` : undefined;

    if ((user as any)?.email && ((user as any)?.notificationSettings?.emailEnabled ?? true)) {
      await sendTrialEndingReminderEmail((user as any).email, { daysLeft: left, trialEndDate: endDate, manageUrl });
    }

    await Promise.all([
      XXSubscription.updateOne({ _id: sub._id }, { $addToSet: { trialReminderStages: stage } }),
      xxNotifyUser(String(sub.userId), `Your free trial ends in ${left} day${left !== 1 ? 's' : ''}. Subscribe to keep access.`),
    ]);
  }
}

export function startXXTrialReminderWorker(): void {
  console.log(`[XXTrialReminder] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  xxProcessTrialReminders().catch((err) => console.error('[XXTrialReminder] Startup error:', err));
  setInterval(() => {
    xxProcessTrialReminders().catch((err) => console.error('[XXTrialReminder] Error:', err));
  }, WORKER_INTERVAL_MS);
}
