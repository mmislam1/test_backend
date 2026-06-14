import axios from 'axios';
import { User } from '../../models/users';
import { XXPayment } from '../../models/xxpayment';
import { XXSubscription, type IXXSubscription, type XXSubscriptionStatus } from '../../models/xxsubscription';
import type { XXBillingCycle, XXPlanTier } from '../../models/xxplan';
import { getXXPlanDefinition, getXXPriceId } from './xxbilling.constants';
import {
  xxApplyEntitlementsForSubscription,
  xxIsPaddlePriceId,
  xxIsTierDowngrade,
  xxMapStatusToUserStatus,
  xxNotifyUser,
} from './xxbilling.service';
import { xxLogBilling, xxSafeSerializeForLog } from './xxbilling.logger';

const paddleBase = () =>
  process.env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

export const xxPaddleRequest = async (
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
) => {
  const apiKey = process.env.PADDLE_API_KEY?.trim();
  if (!apiKey) throw new Error('Paddle API key not configured.');

  console.log(`[XXPaddle API] ${method.toUpperCase()} ${path} | request=${xxSafeSerializeForLog(body ?? null)}`);

  try {
    const res = await axios({
      method,
      url: `${paddleBase()}${path}`,
      data: body,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    console.log(`[XXPaddle API] ${method.toUpperCase()} ${path} | response=${xxSafeSerializeForLog({
      status: res.status,
      id: res.data?.data?.id,
      statusText: res.data?.data?.status,
    })}`);

    return res.data;
  } catch (err: any) {
    console.error(`[XXPaddle API] ${method.toUpperCase()} ${path} | error=${xxSafeSerializeForLog({
      status: err?.response?.status,
      data: err?.response?.data,
      message: err?.message,
    })}`);
    throw err;
  }
};

export const xxIsPaddleNotFoundError = (err: any): boolean =>
  err?.response?.data?.error?.code === 'not_found';

const normalizeStatus = (status: string | undefined): XXSubscriptionStatus => {
  const map: Record<string, XXSubscriptionStatus> = {
    active: 'active',
    trialing: 'trialing',
    paused: 'paused',
    past_due: 'past_due',
    canceled: 'cancelled',
    cancelled: 'cancelled',
  };
  return map[String(status ?? '')] ?? 'pending';
};

const billingCycleFromPaddle = (data: any): XXBillingCycle =>
  data?.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';

const tierForPriceId = (priceId: string): XXPlanTier | null => {
  const tiers: XXPlanTier[] = ['starter', 'pro', 'premium'];
  for (const tier of tiers) {
    const def = getXXPlanDefinition(tier);
    if (def.paddleMonthlyPriceId === priceId || def.paddleAnnualPriceId === priceId) return tier;
  }
  return null;
};

const resolveUserId = async (
  customData: Record<string, any>,
  paddleSubscriptionId?: string,
  paddleCustomerId?: string,
): Promise<string | undefined> => {
  if (customData.userId) return String(customData.userId);
  if (paddleSubscriptionId) {
    const sub = await XXSubscription.findOne({ paddleSubscriptionId }).select('userId').lean();
    if (sub?.userId) return String(sub.userId);
  }
  if (paddleCustomerId) {
    const user = await User.findOne({ paddleCustomerId }).select('_id').lean();
    if (user?._id) return String(user._id);
  }
  return undefined;
};

export const xxGetOrCreatePaddleCustomer = async (
  userId: string,
  email: string,
  name?: string,
) => {
  const existing = await User.findById(userId).select('paddleCustomerId').lean();
  if ((existing as any)?.paddleCustomerId) return (existing as any).paddleCustomerId as string;

  const search = await xxPaddleRequest('get', `/customers?email=${encodeURIComponent(email)}&per_page=5`);
  const found = search?.data?.[0]?.id;
  if (found) {
    await User.findByIdAndUpdate(userId, { paddleCustomerId: found });
    return found as string;
  }

  const created = await xxPaddleRequest('post', '/customers', {
    email,
    ...(name ? { name } : {}),
  });
  const paddleCustomerId = created?.data?.id;
  if (!paddleCustomerId) throw new Error('Paddle did not return a customer ID.');
  await User.findByIdAndUpdate(userId, { paddleCustomerId });
  return paddleCustomerId as string;
};

const syncUserSubscriptionPointer = async (sub: IXXSubscription) => {
  const userStatus = xxMapStatusToUserStatus(sub.status);
  await User.findByIdAndUpdate(String(sub.userId), {
    subscriptionId: sub._id,
    paddleCustomerId: sub.paddleCustomerId,
    paddleSubscriptionId: sub.paddleSubscriptionId,
    ...(userStatus ? { subscriptionStatus: userStatus } : {}),
  });
};

/** Exported alias used by the trial-expiry worker to activate deferred subscriptions. */
export const syncUserSubscriptionPointerFromWorker = syncUserSubscriptionPointer;

export const xxPatchPaddleSubscriptionPlan = async (
  paddleSubscriptionId: string,
  tier: XXPlanTier,
  billingCycle: XXBillingCycle,
) => {
  const priceId = getXXPriceId(tier, billingCycle);
  if (!priceId || !xxIsPaddlePriceId(priceId)) {
    throw new Error(`Paddle price ID is not configured for ${tier} (${billingCycle}).`);
  }

  const current = (await xxPaddleRequest('get', `/subscriptions/${paddleSubscriptionId}`))?.data;
  const items = Array.isArray(current?.items) ? current.items : [];
  const nextItems = items.length
    ? items.map((item: any, index: number) => ({
        price_id: index === 0 ? priceId : item?.price?.id,
        quantity: Number(item?.quantity ?? 1) || 1,
      }))
    : [{ price_id: priceId, quantity: 1 }];

  return xxPaddleRequest('patch', `/subscriptions/${paddleSubscriptionId}`, {
    items: nextItems,
    proration_billing_mode: 'do_not_bill',
  });
};

export const xxSyncSubscriptionFromPaddlePayload = async (
  data: any,
  fallbackUserId?: string,
) => {
  const priceId = data?.items?.[0]?.price?.id ?? data?.items?.[0]?.price_id;
  if (!data?.id || !priceId) {
    await xxLogBilling({
      event: 'paddle_subscription_skipped',
      source: 'paddle',
      level: 'warn',
      message: 'Paddle subscription payload was missing id or price id.',
      metadata: { id: data?.id, priceId },
    });
    return null;
  }

  const tier = tierForPriceId(String(priceId));
  if (!tier) throw new Error(`No xx billing plan matched Paddle price ID: ${priceId}`);

  const userId = fallbackUserId ?? await resolveUserId(data.custom_data || {}, data.id, data.customer_id);
  if (!userId) throw new Error(`[XXPaddle] Could not resolve userId for subscription ${data.id}`);

  const incomingStatus = normalizeStatus(data.status);
  const billingCycle = billingCycleFromPaddle(data);
  const periodEnd = data.current_billing_period?.ends_at
    ? new Date(data.current_billing_period.ends_at)
    : data.next_billed_at
      ? new Date(data.next_billed_at)
      : undefined;
  const trialEnd = incomingStatus === 'trialing' && data.next_billed_at
    ? new Date(data.next_billed_at)
    : undefined;
  const scheduledCancel = data.scheduled_change?.action === 'cancel' && data.scheduled_change?.effective_at
    ? new Date(data.scheduled_change.effective_at)
    : undefined;

  // For a pending deferred subscription that gets cancelled by Paddle, Paddle's
  // effective_at / canceled_at is the purchase-anchored period end — which doesn't
  // account for the trial gap. We use the locally-stored currentPeriodEnd
  // (already adjusted for the trial gap) if it is later than what Paddle reports.
  const existing = await XXSubscription.findOne({ paddleSubscriptionId: data.id });
  const rawCancelDate = scheduledCancel
    ?? (incomingStatus === 'cancelled'
      ? (data.canceled_at ? new Date(data.canceled_at) : new Date())
      : undefined);

  let cancelDate = rawCancelDate;
  if (rawCancelDate && existing?.deferredActivationDate && existing?.currentPeriodEnd) {
    // Prefer the locally-adjusted period end if it is later (user is entitled to the
    // full deferred period, not just what Paddle's clock says).
    if (existing.currentPeriodEnd.getTime() > rawCancelDate.getTime()) {
      cancelDate = existing.currentPeriodEnd;
    }
  }

  
  const status = incomingStatus;
  const shouldUseScheduledChange =
    !!existing?.nextPlanTier &&
    !!existing?.nextBillingCycle &&
    !!periodEnd &&
    periodEnd.getTime() > Date.now() + 60_000 &&
    !cancelDate;

  // --- Downgrade-while-trialing guard ---
  // If the user is on an active local trial and the incoming paid plan is a tier downgrade
  // (e.g. bought Starter while trialling Pro), we must NOT cancel the trial immediately.
  // Instead we store the Paddle subscription as 'deferred_trial_downgrade' so it activates
  // automatically when the trial expires.
  const activeLocalTrial = await XXSubscription.findOne({
    userId,
    status: { $in: ['active', 'trialing'] },
    grantSource: { $in: ['trial', 'referral'] },
    paddleSubscriptionId: { $exists: false },
    currentPeriodEnd: { $gt: new Date() },
  }).lean();

  const isDowngradeWhileTrialing =
    !!activeLocalTrial &&
    !cancelDate &&
    (status === 'active' || status === 'trialing') &&
    xxIsTierDowngrade(activeLocalTrial.planTier as any, tier);

  if (isDowngradeWhileTrialing) {
    // Persist the Paddle subscription record but mark it as pending so it doesn't
    // displace the running trial. We record deferredActivationDate = trial end so
    // the trial-expiry worker knows when to flip it to active.
    const deferredActivationDate = activeLocalTrial.currentPeriodEnd!;

    // Paddle's periodEnd is anchored to the purchase date. Once the deferred sub
    // activates (at trialEnd), the user's effective access end is:
    //   trialEnd + (Paddle billingPeriod length)
    // We compute this now and store it as currentPeriodEnd so cancelDate is correct
    // if the user later turns off auto-renew.
    const paddlePeriodLengthMs =
      periodEnd && data.created_at
        ? periodEnd.getTime() - new Date(data.created_at).getTime()
        : billingCycle === 'annual'
          ? 365 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
    const effectivePeriodEnd = new Date(deferredActivationDate.getTime() + paddlePeriodLengthMs);

    const deferredSub = await XXSubscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: {
          userId,
          planTier: tier,
          billingCycle,
          grantSource: 'paid',
          status: 'pending',
          activationDate: existing?.activationDate ?? (data.created_at ? new Date(data.created_at) : new Date()),
          paddleSubscriptionId: data.id,
          paddleCustomerId: data.customer_id,
          paddlePriceId: String(priceId),
          autoRenewEnabled: !cancelDate,
          deferredActivationDate,
          // Store the trial-gap-adjusted period end so cancelDate is correct downstream.
          currentPeriodEnd: effectivePeriodEnd,
          nextBillingDate: effectivePeriodEnd,
        },
        $unset: { cancelDate: '', trialEndDate: '', nextPlanTier: '', nextBillingCycle: '' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await xxLogBilling({
      userId,
      event: 'paddle_subscription_deferred_downgrade',
      source: 'paddle',
      message: `Paid ${tier} (${billingCycle}) purchase deferred: user is trialling ${activeLocalTrial.planTier}. Will activate after trial ends on ${deferredActivationDate.toISOString()}.`,
      paddleSubscriptionId: data.id,
      metadata: { tier, billingCycle, trialTier: activeLocalTrial.planTier, deferredActivationDate },
    });

    await xxNotifyUser(
      userId,
      `Your ${getXXPlanDefinition(tier).name} plan purchase was successful. It will activate automatically when your current trial ends.`,
      { tier, billingCycle, deferredActivationDate },
    );

    return deferredSub;
  }
  // --- End downgrade-while-trialing guard ---

  // --- Same-tier or upgrade-while-trialing: add remaining trial days to the paid period ---
  // If buying the same tier or upgrading while in an active local trial, we tack the
  // remaining trial days onto the Paddle period so the user doesn't lose them.
  const remainingTrialMs =
    activeLocalTrial && !isDowngradeWhileTrialing && periodEnd
      ? Math.max(0, activeLocalTrial.currentPeriodEnd!.getTime() - Date.now())
      : 0;

  const adjustedPeriodEnd =
    remainingTrialMs > 0 && periodEnd
      ? new Date(periodEnd.getTime() + remainingTrialMs)
      : periodEnd;

  if (remainingTrialMs > 0 && activeLocalTrial) {
    const remainingDays = Math.ceil(remainingTrialMs / (24 * 60 * 60 * 1000));
    await xxLogBilling({
      userId,
      event: 'trial_days_carried_forward',
      source: 'paddle',
      message: `User bought ${tier} while trialling ${activeLocalTrial.planTier}. Adding ${remainingDays} remaining trial day(s) to the paid period.`,
      paddleSubscriptionId: data.id,
      metadata: { tier, billingCycle, remainingDays, originalPeriodEnd: periodEnd, adjustedPeriodEnd },
    });
  }

  const sub = await XXSubscription.findOneAndUpdate(
    { paddleSubscriptionId: data.id },
    {
      $set: {
        userId,
        planTier: shouldUseScheduledChange ? existing!.planTier : tier,
        billingCycle: shouldUseScheduledChange ? existing!.billingCycle : billingCycle,
        grantSource: status === 'trialing' ? 'trial' : 'paid',
        status,
        activationDate: existing?.activationDate ?? (data.created_at ? new Date(data.created_at) : new Date()),
        paddleSubscriptionId: data.id,
        paddleCustomerId: data.customer_id,
        paddlePriceId: String(priceId),
        autoRenewEnabled: !cancelDate && status !== 'cancelled',
        ...(adjustedPeriodEnd ? { currentPeriodEnd: adjustedPeriodEnd, nextBillingDate: adjustedPeriodEnd } : {}),
        ...(trialEnd ? { trialEndDate: trialEnd } : {}),
        ...(cancelDate ? { cancelDate } : {}),
        ...(!cancelDate ? { autoRenewReminderStages: [] } : {}),
        ...(!trialEnd ? { trialReminderStages: [] } : {}),
      },
      $unset: {
        deferredActivationDate: '',
        ...(!shouldUseScheduledChange ? { nextPlanTier: '', nextBillingCycle: '' } : {}),
        ...(!cancelDate ? { cancelDate: '' } : {}),
        ...(!trialEnd ? { trialEndDate: '' } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await Promise.all([
    syncUserSubscriptionPointer(sub),
    // Cancel any other active local subscriptions (trial or referral) for this user,
    // since the paid plan is now live (same-tier or upgrade path).
    XXSubscription.updateMany(
      {
        userId,
        _id: { $ne: sub._id },
        status: { $in: ['active', 'trialing', 'past_due'] },
      },
      { $set: { status: 'cancelled', cancelDate: new Date(), autoRenewEnabled: false } },
    ),
  ]);

  if (status === 'active') {
    await xxApplyEntitlementsForSubscription(sub, existing ? 'subscription update/renewal' : 'subscription activation');
  }

  await xxLogBilling({
    userId,
    event: 'paddle_subscription_synced',
    source: 'paddle',
    message: `Paddle subscription synced as ${status} on ${sub.planTier} (${sub.billingCycle}).${remainingTrialMs > 0 ? ` Trial days carried forward (period extended to ${adjustedPeriodEnd?.toISOString()}).` : ''}`,
    paddleSubscriptionId: data.id,
    metadata: { tier, billingCycle, periodEnd: adjustedPeriodEnd, scheduledCancel: cancelDate },
  });

  return sub;
};

export class XXPaddleService {
  static async handleTransactionCompleted(data: any) {
    const existing = await XXPayment.findOne({ paddleTransactionId: data.id });
    if (existing) return existing;

    const userId = await resolveUserId(data.custom_data || {}, data.subscription_id, data.customer_id);
    if (!userId) {
      await xxLogBilling({
        event: 'transaction_user_unresolved',
        source: 'paddle',
        level: 'warn',
        message: `Could not resolve user for transaction ${data.id}.`,
        paddleTransactionId: data.id,
      });
      return null;
    }

    const payment = await XXPayment.create({
      userId,
      amount: parseInt(data.details?.totals?.total ?? '0', 10) / 100,
      currency: data.currency_code ?? 'USD',
      status: 'completed',
      paddleTransactionId: data.id,
      paddleSubscriptionId: data.subscription_id,
    });

    await Promise.all([
      xxNotifyUser(userId, `Payment of ${payment.currency} ${payment.amount} was successful.`, {
        paddleTransactionId: data.id,
      }),
      xxLogBilling({
        userId,
        event: 'transaction_completed',
        source: 'paddle',
        message: `Payment completed for ${payment.currency} ${payment.amount}.`,
        paddleTransactionId: data.id,
        paddleSubscriptionId: data.subscription_id,
      }),
    ]);

    return payment;
  }

  static async handleTransactionFailed(data: any) {
    const userId = await resolveUserId(data.custom_data || {}, data.subscription_id, data.customer_id);
    if (!userId) return;

    await Promise.all([
      XXPayment.findOneAndUpdate(
        { paddleTransactionId: data.id },
        {
          $setOnInsert: {
            userId,
            amount: parseInt(data.details?.totals?.total ?? '0', 10) / 100,
            currency: data.currency_code ?? 'USD',
            status: 'failed',
            paddleTransactionId: data.id,
            paddleSubscriptionId: data.subscription_id,
          },
        },
        { upsert: true },
      ),
      xxNotifyUser(userId, 'A recent payment attempt failed. Please update your billing information.', {
        paddleTransactionId: data.id,
      }),
      xxLogBilling({
        userId,
        event: 'transaction_failed',
        source: 'paddle',
        level: 'warn',
        message: 'A Paddle payment attempt failed.',
        paddleTransactionId: data.id,
        paddleSubscriptionId: data.subscription_id,
      }),
    ]);
  }

  static async handleAdjustmentCreated(data: any) {
    await xxLogBilling({
      event: 'adjustment_ignored_no_refund_policy',
      source: 'paddle',
      level: 'warn',
      message: 'Paddle adjustment event received. Local policy is no refunds; no entitlement credit was changed.',
      paddleTransactionId: data.transaction_id,
      metadata: { action: data.action, status: data.status },
    });
  }

  static async handleSubscriptionCreated(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload(data);
    if (sub) {
      await xxNotifyUser(String(sub.userId), `Your ${getXXPlanDefinition(sub.planTier).name} checkout is being processed.`, {
        paddleSubscriptionId: sub.paddleSubscriptionId,
      });
    }
  }

  static async handleSubscriptionTrialing(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload(data);
    if (sub) {
      await xxNotifyUser(String(sub.userId), `Your ${getXXPlanDefinition(sub.planTier).name} trial is active.`, {
        paddleSubscriptionId: sub.paddleSubscriptionId,
      });
    }
  }

  static async handleSubscriptionActivated(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload(data);
    if (sub) {
      await xxNotifyUser(String(sub.userId), `Your ${getXXPlanDefinition(sub.planTier).name} (${sub.billingCycle}) subscription is active.`, {
        paddleSubscriptionId: sub.paddleSubscriptionId,
      });
    }
  }

  static async handleSubscriptionUpdated(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload(data);
    if (sub) {
      const plan = getXXPlanDefinition(sub.planTier);
      const title = sub.cancelDate
        ? `Auto-renew is off. Your ${plan.name} plan stays active until the current period ends.`
        : `Your billing status has been updated for ${plan.name} (${sub.billingCycle}).`;
      await xxNotifyUser(String(sub.userId), title, { paddleSubscriptionId: sub.paddleSubscriptionId });
    }
  }

  static async handleSubscriptionPastDue(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload({ ...data, status: 'past_due' });
    if (sub) await xxNotifyUser(String(sub.userId), 'Your subscription payment is past due. Please update your billing information.');
  }

  static async handleSubscriptionPaused(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload({ ...data, status: 'paused' });
    if (sub) await xxNotifyUser(String(sub.userId), 'Your subscription has been paused.');
  }

  static async handleSubscriptionResumed(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload({ ...data, status: 'active' });
    if (sub) await xxNotifyUser(String(sub.userId), 'Your subscription has been resumed.');
  }

  static async handleSubscriptionCanceled(data: any) {
    const sub = await xxSyncSubscriptionFromPaddlePayload({ ...data, status: 'canceled' });
    if (sub) {
      await User.findByIdAndUpdate(String(sub.userId), {
        subscriptionId: null,
        subscriptionStatus: 'canceled',
      });
      await xxNotifyUser(String(sub.userId), 'Your subscription has been cancelled.');
    }
  }
}
