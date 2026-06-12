import { User } from '../../models/users';
import { XXSubscription } from '../../models/xxsubscription';
import { sendAutoRenewOffReminderEmail } from '../notifications/notification-email.service';
import { xxNotifyUser } from './xxbilling.service';

const WORKER_INTERVAL_MS = parseInt(process.env.AUTO_RENEW_REMINDER_INTERVAL_MS ?? '', 10) || 12 * 60 * 60 * 1000;
const REMINDER_STAGES = [7, 5, 3] as const;

const daysLeft = (date: Date) => Math.max(0, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

async function xxProcessAutoRenewReminders(): Promise<void> {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const subs = await XXSubscription.find({
    status: { $in: ['active', 'trialing', 'past_due'] },
    paddleSubscriptionId: { $exists: true, $ne: null },
    cancelDate: { $gt: now, $lte: weekAhead },
  })
    .select('userId cancelDate autoRenewReminderStages')
    .lean();

  for (const sub of subs) {
    if (!sub.cancelDate) continue;
    const cancelDate = new Date(sub.cancelDate);
    const left = daysLeft(cancelDate);
    const sent = Array.isArray(sub.autoRenewReminderStages) ? sub.autoRenewReminderStages : [];
    const stage = Math.min(...REMINDER_STAGES.filter((item) => left <= item && !sent.includes(item)));
    if (!Number.isFinite(stage)) continue;

    const user = await User.findById(sub.userId).select('email notificationSettings.emailEnabled').lean();
    const manageUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/user/billing` : undefined;

    if ((user as any)?.email && ((user as any)?.notificationSettings?.emailEnabled ?? true)) {
      await sendAutoRenewOffReminderEmail((user as any).email, { daysLeft: left, cancelDate, manageUrl });
    }

    await Promise.all([
      XXSubscription.updateOne({ _id: sub._id }, { $addToSet: { autoRenewReminderStages: stage } }),
      xxNotifyUser(String(sub.userId), `Auto-renew is off. ${left} day${left !== 1 ? 's' : ''} left before your plan ends.`),
    ]);
  }
}

export function startXXAutoRenewReminderWorker(): void {
  console.log(`[XXAutoRenewReminder] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  xxProcessAutoRenewReminders().catch((err) => console.error('[XXAutoRenewReminder] Startup error:', err));
  setInterval(() => {
    xxProcessAutoRenewReminders().catch((err) => console.error('[XXAutoRenewReminder] Error:', err));
  }, WORKER_INTERVAL_MS);
}
