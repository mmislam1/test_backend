import axios from 'axios';
import { User } from '../../models/users';
import { XXPayment } from '../../models/xxpayment';
import { XXSubscription, type IXXSubscription, type XXSubscriptionStatus } from '../../models/xxsubscription';
import type { XXBillingCycle, XXPlanTier } from '../../models/xxplan';
import { getXXPlanDefinition, getXXPriceId } from './xxbilling.constants';
import {
  xxApplyEntitlementsForSubscription,
  xxGetActiveLocalGrantForUser,
  xxIsPaddlePriceId,
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
  const cancelDate = scheduledCancel
    ?? (incomingStatus === 'cancelled'
      ? (data.canceled_at ? new Date(data.canceled_at) : new Date())
      : undefined);

  const existing = await XXSubscription.findOne({ paddleSubscriptionId: data.id });
  const existingActivationDate = existing?.activationDate ? new Date(existing.activationDate) : undefined;
  const shouldRemainPending =
    existing?.status === 'pending' &&
    !!existingActivationDate &&
    existingActivationDate.getTime() > Date.now() &&
    ['active', 'trialing', 'past_due'].includes(incomingStatus);

  const activeLocalGrant = !existing && ['active', 'trialing', 'past_due'].includes(incomingStatus)
    ? await xxGetActiveLocalGrantForUser(userId)
    : null;
  const shouldDeferForLocalGrant = !!activeLocalGrant?.currentPeriodEnd;
  const deferredActivationDate = shouldRemainPending
    ? existingActivationDate
    : shouldDeferForLocalGrant
      ? activeLocalGrant.currentPeriodEnd
      : undefined;
  const shouldKeepPendingCancellation =
    existing?.status === 'cancelled' &&
    existing?.grantSource === 'paid' &&
    !!existing.cancelDate &&
    !!scheduledCancel &&
    !!existingActivationDate &&
    existingActivationDate.getTime() > Date.now();
  const status = shouldKeepPendingCancellation
    ? 'cancelled'
    : shouldRemainPending || shouldDeferForLocalGrant
      ? 'pending'
      : incomingStatus;
  const shouldUseScheduledChange =
    !!existing?.nextPlanTier &&
    !!existing?.nextBillingCycle &&
    !!periodEnd &&
    periodEnd.getTime() > Date.now() + 60_000 &&
    !cancelDate;

  const sub = await XXSubscription.findOneAndUpdate(
    { paddleSubscriptionId: data.id },
    {
      $set: {
        userId,
        planTier: shouldUseScheduledChange ? existing.planTier : tier,
        billingCycle: shouldUseScheduledChange ? existing.billingCycle : billingCycle,
        grantSource: 'paid',
        status,
        activationDate: deferredActivationDate ?? existing?.activationDate ?? (data.created_at ? new Date(data.created_at) : new Date()),
        paddleSubscriptionId: data.id,
        paddleCustomerId: data.customer_id,
        paddlePriceId: String(priceId),
        autoRenewEnabled: !cancelDate && status !== 'cancelled',
        ...(periodEnd ? { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd } : {}),
        ...(trialEnd ? { trialEndDate: trialEnd } : {}),
        ...(cancelDate ? { cancelDate } : {}),
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(status === 'pending'
            ? {
                pendingPaddleStatus: incomingStatus,
                pendingReason: 'local_grant_active',
                pendingUntil: deferredActivationDate,
              }
            : {}),
        },
        ...(!cancelDate ? { autoRenewReminderStages: [] } : {}),
        ...(!trialEnd ? { trialReminderStages: [] } : {}),
      },
      $unset: {
        ...(!shouldUseScheduledChange ? { nextPlanTier: '', nextBillingCycle: '' } : {}),
        ...(!cancelDate ? { cancelDate: '' } : {}),
        ...(!trialEnd ? { trialEndDate: '' } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const cancelOtherSubscriptionsFilter: Record<string, any> = {
    userId,
    _id: { $ne: sub._id },
    status: { $in: ['active', 'trialing', 'past_due'] },
  };
  const preservesLocalGrant = status === 'pending' || shouldKeepPendingCancellation;
  if (preservesLocalGrant) {
    cancelOtherSubscriptionsFilter.paddleSubscriptionId = { $exists: true, $ne: null };
  }

  await Promise.all([
    preservesLocalGrant
      ? User.findByIdAndUpdate(userId, {
          paddleCustomerId: sub.paddleCustomerId,
          paddleSubscriptionId: sub.paddleSubscriptionId,
        })
      : syncUserSubscriptionPointer(sub),
    XXSubscription.updateMany(
      cancelOtherSubscriptionsFilter,
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
    message: `Paddle subscription synced as ${status} on ${sub.planTier} (${sub.billingCycle}).`,
    paddleSubscriptionId: data.id,
    metadata: { tier, billingCycle, periodEnd, scheduledCancel: cancelDate, deferredActivationDate },
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
