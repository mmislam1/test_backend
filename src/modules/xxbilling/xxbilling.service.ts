import { Types } from 'mongoose';
import { User } from '../../models/users';
import {
  XxSubscription,
  type IXxSubscription,
  type XxBillingCycle as ModelBillingCycle,
  type XxPlanTier as ModelPlanTier,
  type XxSubscriptionStatus,
} from '../../models/xxsubscription';
import { XxPayment } from '../../models/xxpayment';
import { XxBillingLog, type XxBillingLogLevel } from '../../models/xxbilling-log';
import {
  XX_PLAN_DEFINITIONS,
  getXxPlanByPriceId,
  getXxPlanDefinition,
  getXxPlanPriceId,
  normalizeXxBillingCycle,
  normalizeXxPlanTier,
  serializeXxPlan,
} from './xxbilling.catalog';
import type { XxBillingCycle, XxPlanDefinition, XxPlanTier } from './xxbilling.types';
import {
  addBillingPeriod,
  addDays,
  formatXxDate,
  isFutureDate,
  parsePaddleAmount,
  safeXxSerialize,
} from './xxbilling.utils';
import { xxPaddleRequest } from './xxpaddle-client';

const ACTIVE_STATUSES: XxSubscriptionStatus[] = ['active', 'trialing', 'past_due'];
const USER_STATUS_BY_XX_STATUS: Partial<Record<XxSubscriptionStatus, 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused'>> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
  expired: 'canceled',
};
const PADDLE_STATUS_MAP: Record<string, XxSubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
};
const SCHEDULE_SYNC_LOOKAHEAD_MS =
  parseInt(process.env.XX_PENDING_CHANGE_SYNC_LOOKAHEAD_MS ?? '', 10) || 30 * 60 * 1000;

const toObjectId = (value: string): Types.ObjectId => new Types.ObjectId(value);

const getPaddleErrorMessage = (error: any): string =>
  error?.response?.data?.error?.detail ||
  error?.response?.data?.error?.code ||
  error?.message ||
  'Paddle request failed.';

export const writeXxBillingLog = async ({
  userId,
  xxSubscriptionId,
  level = 'info',
  eventType,
  message,
  notifyFrontend = false,
  paddleEventId,
  metadata,
}: {
  userId?: string;
  xxSubscriptionId?: string;
  level?: XxBillingLogLevel;
  eventType: string;
  message: string;
  notifyFrontend?: boolean;
  paddleEventId?: string;
  metadata?: Record<string, unknown>;
}) => {
  console.log(`[XX Billing] ${eventType} | ${message} | ${safeXxSerialize(metadata ?? {})}`);
  return XxBillingLog.create({
    userId: userId ? toObjectId(userId) : undefined,
    xxSubscriptionId: xxSubscriptionId ? toObjectId(xxSubscriptionId) : undefined,
    level,
    eventType,
    message,
    notifyFrontend,
    paddleEventId,
    metadata,
  });
};

const serializeSubscription = (subscription: any) => {
  if (!subscription) return null;
  const plan = getXxPlanDefinition(subscription.planTier as XxPlanTier);
  const scheduledPlan = subscription.scheduledChange?.planTier
    ? getXxPlanDefinition(subscription.scheduledChange.planTier as XxPlanTier)
    : null;

  return {
    id: String(subscription._id),
    status: subscription.status,
    source: subscription.source,
    plan: serializeXxPlan(plan),
    billingCycle: subscription.billingCycle,
    activationDate: subscription.activationDate ?? null,
    currentPeriodStart: subscription.currentPeriodStart ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    trialEndsAt: subscription.trialEndsAt ?? null,
    nextBillingDate: subscription.nextBillingDate ?? null,
    autoRenew: Boolean(subscription.autoRenew),
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    cancelAt: subscription.cancelAt ?? null,
    paddleCustomerId: subscription.paddleCustomerId ?? null,
    paddleSubscriptionId: subscription.paddleSubscriptionId ?? null,
    scheduledChange: subscription.scheduledChange
      ? {
          plan: scheduledPlan ? serializeXxPlan(scheduledPlan) : null,
          billingCycle: subscription.scheduledChange.billingCycle,
          effectiveAt: subscription.scheduledChange.effectiveAt,
          requestedAt: subscription.scheduledChange.requestedAt,
          status: subscription.scheduledChange.status,
          paddleSyncedAt: subscription.scheduledChange.paddleSyncedAt ?? null,
        }
      : null,
    policy: {
      noRefunds: true,
      planChangesActivateAfterCurrentPeriod: true,
      downgradeDiscounts: false,
    },
  };
};

export const getXxPlansForFrontend = () => XX_PLAN_DEFINITIONS.map(serializeXxPlan);

export const getLatestXxSubscription = async (userId: string) => {
  const subscription = await XxSubscription.findOne({ userId })
    .sort({ activationDate: -1, createdAt: -1 })
    .lean();
  return serializeSubscription(subscription);
};

const findCurrentXxSubscriptionDoc = async (
  userId: string,
  statuses: XxSubscriptionStatus[] = ACTIVE_STATUSES,
) =>
  XxSubscription.findOne({
    userId,
    status: { $in: statuses },
  }).sort({ activationDate: -1, createdAt: -1 });

const cancelOtherXxSubscriptions = async (userId: string, keepId: Types.ObjectId | string) => {
  await XxSubscription.updateMany(
    {
      userId,
      _id: { $ne: keepId },
      status: { $in: ['pending', 'trialing', 'active', 'past_due', 'paused'] },
    },
    {
      $set: {
        status: 'canceled',
        canceledAt: new Date(),
        cancelAtPeriodEnd: false,
        autoRenew: false,
      },
      $unset: { scheduledChange: '' },
    },
  );
};

const updateUserSubscriptionMirror = async (
  userId: string,
  subscription: IXxSubscription | any,
  status: XxSubscriptionStatus,
) => {
  const userStatus = USER_STATUS_BY_XX_STATUS[status];
  const update: Record<string, unknown> = {
    ...(userStatus ? { subscriptionStatus: userStatus } : {}),
  };
  if (subscription?.paddleCustomerId) update.paddleCustomerId = subscription.paddleCustomerId;
  if (subscription?.paddleSubscriptionId) update.paddleSubscriptionId = subscription.paddleSubscriptionId;

  const unset: Record<string, string> = {};
  if (status === 'canceled' || status === 'expired') {
    unset.paddleSubscriptionId = '';
  }

  const updateDoc: Record<string, unknown> = {};
  if (Object.keys(update).length) updateDoc.$set = update;
  if (Object.keys(unset).length) updateDoc.$unset = unset;
  if (Object.keys(updateDoc).length) {
    await User.findByIdAndUpdate(userId, updateDoc);
  }
};

const grantXxEntitlements = async ({
  userId,
  subscriptionId,
  plan,
  grantKey,
  reason,
}: {
  userId: string;
  subscriptionId: string;
  plan: XxPlanDefinition;
  grantKey: string;
  reason: string;
}): Promise<boolean> => {
  const updatedSub = await XxSubscription.findOneAndUpdate(
    {
      _id: subscriptionId,
      $or: [
        { lastEntitlementGrantKey: { $exists: false } },
        { lastEntitlementGrantKey: { $ne: grantKey } },
      ],
    },
    { $set: { lastEntitlementGrantKey: grantKey } },
    { new: true },
  );

  if (!updatedSub) return false;

  const user = await User.findById(userId).select('alertsRemaining credits').lean();
  if (!user) return false;

  const update: Record<string, unknown> = {
    $inc: { credits: plan.monitors },
  };

  if (plan.alertLimit === null) {
    update.$set = { alertsRemaining: -1 };
  } else if ((user as any).alertsRemaining === -1) {
    update.$set = { alertsRemaining: plan.alertLimit };
  } else {
    (update.$inc as Record<string, number>).alertsRemaining = plan.alertLimit;
  }

  await User.findByIdAndUpdate(userId, update);
  await writeXxBillingLog({
    userId,
    xxSubscriptionId: subscriptionId,
    eventType: 'xx.entitlements.granted',
    message: `${plan.monitors} monitoring credits and ${plan.alertLimit === null ? 'unlimited' : plan.alertLimit} alerts were added.`,
    notifyFrontend: true,
    metadata: {
      reason,
      planTier: plan.tier,
      monitorsAdded: plan.monitors,
      alertsAdded: plan.alertLimit,
      grantKey,
    },
  });
  return true;
};

export const ensureXxProTrialOnSignin = async (userId: string) => {
  const existingUser = await User.findById(userId)
    .select('subscriptionStatus paddleSubscriptionId')
    .lean();
  if (!existingUser) return { created: false, subscription: null };

  if (
    ['active', 'trialing', 'past_due'].includes(String((existingUser as any).subscriptionStatus ?? '')) ||
    (existingUser as any).paddleSubscriptionId
  ) {
    return { created: false, subscription: await getLatestXxSubscription(userId) };
  }

  const existingXx = await XxSubscription.findOne({
    userId,
    $or: [
      { source: 'trial' },
      { status: { $in: ['active', 'trialing', 'past_due', 'paused'] } },
    ],
  })
    .sort({ activationDate: -1, createdAt: -1 })
    .lean();

  if (existingXx) {
    return { created: false, subscription: serializeSubscription(existingXx) };
  }

  const now = new Date();
  const trialEndsAt = addDays(now, 7);
  const plan = getXxPlanDefinition('pro');

  try {
    const subscription = await XxSubscription.create({
      userId,
      planTier: 'pro',
      billingCycle: 'monthly',
      source: 'trial',
      status: 'trialing',
      activationDate: now,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      trialEndsAt,
      nextBillingDate: trialEndsAt,
      autoRenew: false,
      cancelAtPeriodEnd: false,
      metadata: { startedBy: 'signin' },
    });

    await updateUserSubscriptionMirror(userId, subscription, 'trialing');
    await grantXxEntitlements({
      userId,
      subscriptionId: String(subscription._id),
      plan,
      grantKey: `trial:pro:${trialEndsAt.toISOString()}`,
      reason: 'signin-trial',
    });
    await writeXxBillingLog({
      userId,
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.trial.started',
      message: 'Your 7-day Pro trial has started.',
      notifyFrontend: true,
      metadata: { trialEndsAt },
    });

    return { created: true, subscription: serializeSubscription(subscription) };
  } catch (error: any) {
    if (error?.code === 11000) {
      return { created: false, subscription: await getLatestXxSubscription(userId) };
    }
    throw error;
  }
};

export const extendXxTrial = async ({
  userId,
  days,
  actorId,
}: {
  userId: string;
  days: number;
  actorId: string;
}) => {
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error('days must be between 1 and 365.');
  }

  const subscription = await XxSubscription.findOne({
    userId,
    source: 'trial',
    status: 'trialing',
  });
  if (!subscription) {
    throw new Error('No active xx trial found for this user.');
  }

  const base = subscription.currentPeriodEnd && subscription.currentPeriodEnd > new Date()
    ? subscription.currentPeriodEnd
    : new Date();
  const nextEnd = addDays(base, days);
  subscription.currentPeriodEnd = nextEnd;
  subscription.trialEndsAt = nextEnd;
  subscription.nextBillingDate = nextEnd;
  await subscription.save();

  await writeXxBillingLog({
    userId,
    xxSubscriptionId: String(subscription._id),
    eventType: 'xx.trial.extended',
    message: `Your Pro trial was extended by ${days} day(s).`,
    notifyFrontend: true,
    metadata: { actorId, days, trialEndsAt: nextEnd },
  });

  return serializeSubscription(subscription);
};

const getOrCreateXxPaddleCustomer = async (userId: string): Promise<string> => {
  const user = await User.findById(userId).select('email name paddleCustomerId').lean();
  if (!user) throw new Error('User not found.');

  const existingCustomerId = String((user as any).paddleCustomerId ?? '').trim();
  if (existingCustomerId) return existingCustomerId;

  const email = String((user as any).email ?? '').trim();
  const name = String((user as any).name ?? '').trim();
  if (!email) throw new Error('User email is required to create a Paddle checkout.');

  const customerSearch = await xxPaddleRequest<any>(
    'get',
    `/customers?email=${encodeURIComponent(email)}&per_page=5`,
  );
  const existing = customerSearch?.data?.[0]?.id;
  if (existing) {
    await User.findByIdAndUpdate(userId, { paddleCustomerId: existing });
    return existing;
  }

  const customerCreate = await xxPaddleRequest<any>('post', '/customers', { email, name });
  const customerId = customerCreate?.data?.id;
  if (!customerId) throw new Error('Paddle did not return a customer ID.');

  await User.findByIdAndUpdate(userId, { paddleCustomerId: customerId });
  return customerId;
};

export const createXxCheckout = async ({
  userId,
  tier,
  billingCycle,
}: {
  userId: string;
  tier: unknown;
  billingCycle: unknown;
}) => {
  const planTier = normalizeXxPlanTier(tier);
  const cycle = normalizeXxBillingCycle(billingCycle) ?? 'monthly';
  if (!planTier) throw new Error('Invalid plan tier. Use starter/standard, pro, or premium.');

  const activePaid = await XxSubscription.findOne({
    userId,
    source: 'paddle',
    status: { $in: ACTIVE_STATUSES },
  }).lean();
  if (activePaid) {
    throw new Error('You already have a Paddle subscription. Schedule a plan change instead.');
  }

  const priceId = getXxPlanPriceId(planTier, cycle);
  if (!priceId) {
    throw new Error(`Paddle price ID is not configured for ${planTier} (${cycle}).`);
  }

  const paddleCustomerId = await getOrCreateXxPaddleCustomer(userId);
  const transaction = await xxPaddleRequest<any>('post', '/transactions', {
    customer_id: paddleCustomerId,
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: {
      system: 'xxbilling',
      userId,
      planTier,
      billingCycle: cycle,
      noRefundPolicy: true,
    },
  });
  const data = transaction?.data;
  if (!data?.id) throw new Error('Paddle did not return a transaction ID.');

  await writeXxBillingLog({
    userId,
    eventType: 'xx.checkout.created',
    message: `Checkout created for ${getXxPlanDefinition(planTier).name} (${cycle}).`,
    metadata: { transactionId: data.id, planTier, billingCycle: cycle },
  });

  return {
    transactionId: data.id,
    checkoutUrl: data.checkout?.url ?? null,
    plan: serializeXxPlan(getXxPlanDefinition(planTier)),
    billingCycle: cycle,
    noRefundPolicy: true,
  };
};

const getXxPlanFromPaddlePayload = (data: any) => {
  const paddlePriceId = data?.items?.[0]?.price?.id ?? data?.items?.[0]?.price_id;
  const planByPrice = getXxPlanByPriceId(paddlePriceId);
  if (planByPrice) return { ...planByPrice, paddlePriceId };

  const customTier = normalizeXxPlanTier(data?.custom_data?.planTier);
  const customCycle = normalizeXxBillingCycle(data?.custom_data?.billingCycle);
  if (customTier) {
    return {
      plan: getXxPlanDefinition(customTier),
      billingCycle: customCycle ?? (data?.billing_cycle?.interval === 'year' ? 'annual' : 'monthly'),
      paddlePriceId,
    };
  }

  return null;
};

const resolveXxUserId = async (
  customData: Record<string, any> | undefined,
  paddleSubscriptionId?: string,
  paddleCustomerId?: string,
): Promise<string | null> => {
  const customUserId = customData?.userId || customData?.xxUserId;
  if (customUserId && Types.ObjectId.isValid(String(customUserId))) {
    return String(customUserId);
  }

  if (paddleSubscriptionId) {
    const sub = await XxSubscription.findOne({ paddleSubscriptionId }).select('userId').lean();
    if (sub?.userId) return String(sub.userId);
  }

  if (paddleCustomerId) {
    const user = await User.findOne({ paddleCustomerId }).select('_id').lean();
    if (user?._id) return String(user._id);
  }

  return null;
};

const maybeSyncScheduledChangeToPaddle = async (subscription: IXxSubscription | any) => {
  const scheduled = subscription.scheduledChange;
  if (
    !scheduled ||
    scheduled.status !== 'scheduled' ||
    scheduled.paddleSyncedAt ||
    subscription.cancelAtPeriodEnd ||
    !subscription.paddleSubscriptionId
  ) {
    return false;
  }

  const effectiveAt = new Date(scheduled.effectiveAt);
  if (effectiveAt.getTime() - Date.now() > SCHEDULE_SYNC_LOOKAHEAD_MS) {
    return false;
  }

  const priceId = getXxPlanPriceId(scheduled.planTier, scheduled.billingCycle);
  if (!priceId) {
    await writeXxBillingLog({
      userId: String(subscription.userId),
      xxSubscriptionId: String(subscription._id),
      level: 'error',
      eventType: 'xx.schedule.sync_failed',
      message: 'Scheduled plan change could not be synced because the Paddle price ID is missing.',
      notifyFrontend: true,
      metadata: { scheduled },
    });
    return false;
  }

  await xxPaddleRequest('patch', `/subscriptions/${subscription.paddleSubscriptionId}`, {
    items: [{ price_id: priceId, quantity: 1 }],
    proration_billing_mode: 'do_not_bill',
  });

  scheduled.paddleSyncedAt = new Date();
  scheduled.paddlePriceId = priceId;
  subscription.markModified?.('scheduledChange');
  await subscription.save?.();
  return true;
};

export const scheduleXxPlanChange = async ({
  userId,
  tier,
  billingCycle,
}: {
  userId: string;
  tier: unknown;
  billingCycle: unknown;
}) => {
  const planTier = normalizeXxPlanTier(tier);
  if (!planTier) throw new Error('Invalid plan tier. Use starter/standard, pro, or premium.');

  const subscription = await findCurrentXxSubscriptionDoc(userId, ACTIVE_STATUSES);
  if (!subscription) throw new Error('No active xx subscription found.');
  if (!subscription.paddleSubscriptionId) {
    throw new Error('Trials must be converted through checkout before scheduling plan changes.');
  }
  if (subscription.cancelAtPeriodEnd || !subscription.autoRenew) {
    throw new Error('Auto-renew is off. Turn it on before scheduling a plan change.');
  }

  const targetCycle = normalizeXxBillingCycle(billingCycle) ?? subscription.billingCycle;
  const priceId = getXxPlanPriceId(planTier, targetCycle);
  if (!priceId) throw new Error(`Paddle price ID is not configured for ${planTier} (${targetCycle}).`);

  const effectiveAt = subscription.currentPeriodEnd ?? addBillingPeriod(new Date(), subscription.billingCycle);
  const requestedAt = new Date();
  subscription.scheduledChange = {
    planTier: planTier as ModelPlanTier,
    billingCycle: targetCycle as ModelBillingCycle,
    effectiveAt,
    requestedAt,
    paddlePriceId: priceId,
    status: 'scheduled',
  };
  await subscription.save();
  await maybeSyncScheduledChangeToPaddle(subscription);

  await writeXxBillingLog({
    userId,
    xxSubscriptionId: String(subscription._id),
    eventType: 'xx.subscription.change_scheduled',
    message: `Your plan will change to ${getXxPlanDefinition(planTier).name} (${targetCycle}) after the current period ends.`,
    notifyFrontend: true,
    metadata: {
      planTier,
      billingCycle: targetCycle,
      effectiveAt,
      noRefundPolicy: true,
      downgradeDiscountApplied: false,
    },
  });

  return serializeSubscription(subscription);
};

export const cancelXxScheduledChange = async (userId: string) => {
  const subscription = await findCurrentXxSubscriptionDoc(userId, ACTIVE_STATUSES);
  if (!subscription) throw new Error('No active xx subscription found.');
  if (!subscription.scheduledChange || subscription.scheduledChange.status !== 'scheduled') {
    return serializeSubscription(subscription);
  }

  subscription.scheduledChange.status = 'canceled';
  subscription.markModified('scheduledChange');
  await subscription.save();
  await XxSubscription.findByIdAndUpdate(subscription._id, { $unset: { scheduledChange: '' } });

  await writeXxBillingLog({
    userId,
    xxSubscriptionId: String(subscription._id),
    eventType: 'xx.subscription.change_canceled',
    message: 'Your scheduled plan change was canceled.',
    notifyFrontend: true,
  });

  const refreshed = await XxSubscription.findById(subscription._id).lean();
  return serializeSubscription(refreshed);
};

export const setXxAutoRenew = async ({
  userId,
  enabled,
}: {
  userId: string;
  enabled: boolean;
}) => {
  const subscription = await findCurrentXxSubscriptionDoc(userId, ACTIVE_STATUSES);
  if (!subscription) throw new Error('No active xx subscription found.');

  if (enabled) {
    if (subscription.paddleSubscriptionId && subscription.cancelAtPeriodEnd) {
      await xxPaddleRequest('patch', `/subscriptions/${subscription.paddleSubscriptionId}`, {
        scheduled_change: null,
      });
    }

    await XxSubscription.findByIdAndUpdate(subscription._id, {
      $set: {
        autoRenew: true,
        cancelAtPeriodEnd: false,
      },
      $unset: { cancelAt: '' },
    });

    await writeXxBillingLog({
      userId,
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.subscription.auto_renew_enabled',
      message: 'Auto-renew is on. Your subscription will renew at the next billing date.',
      notifyFrontend: true,
    });
  } else {
    const effectiveAt = subscription.currentPeriodEnd ?? subscription.nextBillingDate ?? new Date();

    if (subscription.paddleSubscriptionId) {
      await xxPaddleRequest('post', `/subscriptions/${subscription.paddleSubscriptionId}/cancel`, {
        effective_from: 'next_billing_period',
      });
    }

    await XxSubscription.findByIdAndUpdate(subscription._id, {
      $set: {
        autoRenew: false,
        cancelAtPeriodEnd: true,
        cancelAt: effectiveAt,
      },
      $unset: { scheduledChange: '' },
    });

    await writeXxBillingLog({
      userId,
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.subscription.auto_renew_disabled',
      message: 'Auto-renew is off. Any scheduled plan change was canceled.',
      notifyFrontend: true,
      metadata: { effectiveAt },
    });
  }

  const refreshed = await XxSubscription.findById(subscription._id).lean();
  return serializeSubscription(refreshed);
};

const applyXxSubscriptionPayload = async ({
  data,
  eventType,
  paddleEventId,
}: {
  data: any;
  eventType: string;
  paddleEventId?: string;
}) => {
  const resolved = getXxPlanFromPaddlePayload(data);
  if (!resolved) {
    await writeXxBillingLog({
      level: 'warning',
      eventType: 'xx.paddle.plan_unmapped',
      message: 'Paddle subscription event could not be mapped to an xx plan.',
      paddleEventId,
      metadata: { paddleSubscriptionId: data?.id, paddlePriceId: data?.items?.[0]?.price?.id },
    });
    return null;
  }

  const userId = await resolveXxUserId(data?.custom_data, data?.id, data?.customer_id);
  if (!userId) {
    await writeXxBillingLog({
      level: 'warning',
      eventType: 'xx.paddle.user_unresolved',
      message: 'Paddle subscription event could not be mapped to a user.',
      paddleEventId,
      metadata: { paddleSubscriptionId: data?.id, paddleCustomerId: data?.customer_id },
    });
    return null;
  }

  const now = new Date();
  const incomingStatus = PADDLE_STATUS_MAP[String(data?.status ?? '')] ?? 'pending';
  const periodStart = data?.current_billing_period?.starts_at
    ? new Date(data.current_billing_period.starts_at)
    : undefined;
  const periodEnd = data?.current_billing_period?.ends_at
    ? new Date(data.current_billing_period.ends_at)
    : data?.next_billed_at
      ? new Date(data.next_billed_at)
      : undefined;
  const scheduledCancelAt = data?.scheduled_change?.action === 'cancel' && data?.scheduled_change?.effective_at
    ? new Date(data.scheduled_change.effective_at)
    : undefined;
  const existing = await XxSubscription.findOne({ paddleSubscriptionId: data.id });
  const previousPeriodEnd = existing?.currentPeriodEnd;
  const periodAdvanced =
    !!periodEnd &&
    (!previousPeriodEnd || periodEnd.getTime() > previousPeriodEnd.getTime() + 60_000);
  const scheduled = existing?.scheduledChange;
  const scheduledMatchesIncoming =
    scheduled?.status === 'scheduled' &&
    scheduled.planTier === resolved.plan.tier &&
    scheduled.billingCycle === resolved.billingCycle;
  const shouldActivateScheduled =
    Boolean(scheduledMatchesIncoming && (periodAdvanced || !isFutureDate(scheduled?.effectiveAt)));
  const shouldPreserveCurrentPlan =
    Boolean(scheduledMatchesIncoming && !shouldActivateScheduled && existing);
  const planTier = shouldPreserveCurrentPlan ? existing!.planTier : resolved.plan.tier;
  const cycle = shouldPreserveCurrentPlan ? existing!.billingCycle : resolved.billingCycle;
  const status = incomingStatus === 'pending' && eventType === 'subscription.activated'
    ? 'active'
    : incomingStatus;

  const setFields: Record<string, unknown> = {
    userId,
    planTier,
    billingCycle: cycle,
    source: 'paddle',
    status,
    activationDate: existing?.activationDate ?? now,
    paddleCustomerId: data.customer_id,
    paddleSubscriptionId: data.id,
    paddlePriceId: resolved.paddlePriceId,
    lastPaddleEventId: paddleEventId,
    autoRenew: !scheduledCancelAt,
    cancelAtPeriodEnd: Boolean(scheduledCancelAt),
    ...(periodStart ? { currentPeriodStart: periodStart } : {}),
    ...(periodEnd ? { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd } : {}),
    ...(scheduledCancelAt ? { cancelAt: scheduledCancelAt } : {}),
  };
  const unsetFields: Record<string, string> = {};

  if (!scheduledCancelAt) unsetFields.cancelAt = '';
  if (status === 'active') unsetFields.trialEndsAt = '';
  if (shouldActivateScheduled || scheduledCancelAt) {
    unsetFields.scheduledChange = '';
  } else if (scheduled && shouldPreserveCurrentPlan) {
    setFields.scheduledChange = scheduled;
  }

  const updateDoc: Record<string, unknown> = { $set: setFields };
  if (Object.keys(unsetFields).length > 0) updateDoc.$unset = unsetFields;

  const subscription = await XxSubscription.findOneAndUpdate(
    { paddleSubscriptionId: data.id },
    updateDoc,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (ACTIVE_STATUSES.includes(status)) {
    await cancelOtherXxSubscriptions(userId, subscription._id as Types.ObjectId);
  }

  await updateUserSubscriptionMirror(userId, subscription, status);

  const shouldGrantPaidEntitlements =
    status === 'active' &&
    (eventType === 'subscription.activated' || periodAdvanced || !existing || existing.status !== 'active') &&
    periodEnd;

  if (shouldGrantPaidEntitlements) {
    await grantXxEntitlements({
      userId,
      subscriptionId: String(subscription._id),
      plan: getXxPlanDefinition(planTier as XxPlanTier),
      grantKey: `paid:${data.id}:${planTier}:${cycle}:${periodEnd!.toISOString()}`,
      reason: periodAdvanced ? 'renewal' : 'activation',
    });
  }

  if (shouldActivateScheduled) {
    await writeXxBillingLog({
      userId,
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.subscription.scheduled_change_activated',
      message: `Your scheduled ${getXxPlanDefinition(planTier as XxPlanTier).name} (${cycle}) plan is now active.`,
      notifyFrontend: true,
      paddleEventId,
      metadata: { periodAdvanced, effectiveAt: scheduled?.effectiveAt },
    });
  } else {
    await writeXxBillingLog({
      userId,
      xxSubscriptionId: String(subscription._id),
      eventType: `xx.paddle.${eventType}`,
      message: `Paddle subscription update received: ${status}.`,
      notifyFrontend: ['subscription.activated', 'subscription.canceled', 'subscription.past_due', 'subscription.paused', 'subscription.resumed'].includes(eventType),
      paddleEventId,
      metadata: {
        planTier,
        billingCycle: cycle,
        periodEnd,
        scheduledCancelAt,
        shouldPreserveCurrentPlan,
      },
    });
  }

  return subscription;
};

export const handleXxPaddleEvent = async ({
  eventType,
  paddleEventId,
  data,
}: {
  eventType: string;
  paddleEventId?: string;
  data: any;
}) => {
  switch (eventType) {
    case 'subscription.created':
    case 'subscription.trialing':
    case 'subscription.activated':
    case 'subscription.updated':
    case 'subscription.past_due':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.canceled':
      await applyXxSubscriptionPayload({ data, eventType, paddleEventId });
      break;
    case 'transaction.completed':
      await handleXxTransactionCompleted(data, paddleEventId);
      break;
    case 'transaction.payment_failed':
      await handleXxTransactionFailed(data, paddleEventId);
      break;
    case 'adjustment.created':
    case 'adjustment.updated':
      await writeXxBillingLog({
        level: 'warning',
        eventType: `xx.paddle.${eventType}`,
        message: 'Paddle sent an adjustment event. The xx billing system has a no-refund policy and did not issue a refund.',
        notifyFrontend: false,
        paddleEventId,
        metadata: {
          adjustmentId: data?.id,
          action: data?.action,
          transactionId: data?.transaction_id,
        },
      });
      break;
    default:
      await writeXxBillingLog({
        eventType: 'xx.paddle.unhandled_event',
        message: `Unhandled Paddle event: ${eventType}`,
        paddleEventId,
        metadata: { id: data?.id },
      });
  }
};

const handleXxTransactionCompleted = async (data: any, paddleEventId?: string) => {
  const userId = await resolveXxUserId(data?.custom_data, data?.subscription_id, data?.customer_id);
  if (!userId) {
    await writeXxBillingLog({
      level: 'warning',
      eventType: 'xx.payment.user_unresolved',
      message: 'Completed Paddle transaction could not be mapped to a user.',
      paddleEventId,
      metadata: { transactionId: data?.id, subscriptionId: data?.subscription_id },
    });
    return;
  }

  let subscription = data?.subscription_id
    ? await XxSubscription.findOne({ paddleSubscriptionId: data.subscription_id })
    : null;
  if (!subscription && data?.subscription_id) {
    try {
      const paddleSub = await xxPaddleRequest<any>('get', `/subscriptions/${data.subscription_id}`);
      subscription = await applyXxSubscriptionPayload({
        data: paddleSub?.data,
        eventType: 'subscription.updated',
        paddleEventId,
      });
    } catch (error) {
      await writeXxBillingLog({
        userId,
        level: 'warning',
        eventType: 'xx.payment.subscription_sync_failed',
        message: getPaddleErrorMessage(error),
        paddleEventId,
      });
    }
  }

  const planTier = normalizeXxPlanTier(data?.custom_data?.planTier) ?? subscription?.planTier;
  const billingCycle = normalizeXxBillingCycle(data?.custom_data?.billingCycle) ?? subscription?.billingCycle;

  await XxPayment.findOneAndUpdate(
    { paddleTransactionId: data.id },
    {
      $setOnInsert: {
        userId,
        xxSubscriptionId: subscription?._id,
        planTier,
        billingCycle,
        amount: parsePaddleAmount(data?.details?.totals?.total),
        currency: data?.currency_code ?? 'USD',
        status: 'completed',
        paddleTransactionId: data.id,
        paddleSubscriptionId: data.subscription_id,
        metadata: { noRefundPolicy: true },
      },
    },
    { upsert: true, new: true },
  );

  await writeXxBillingLog({
    userId,
    xxSubscriptionId: subscription?._id ? String(subscription._id) : undefined,
    eventType: 'xx.payment.completed',
    message: 'Payment completed successfully.',
    notifyFrontend: true,
    paddleEventId,
    metadata: {
      transactionId: data.id,
      amount: parsePaddleAmount(data?.details?.totals?.total),
      currency: data?.currency_code ?? 'USD',
      noRefundPolicy: true,
    },
  });
};

const handleXxTransactionFailed = async (data: any, paddleEventId?: string) => {
  const userId = await resolveXxUserId(data?.custom_data, data?.subscription_id, data?.customer_id);
  if (!userId) return;

  const subscription = data?.subscription_id
    ? await XxSubscription.findOneAndUpdate(
        { paddleSubscriptionId: data.subscription_id },
        { $set: { status: 'past_due' } },
        { new: true },
      )
    : null;

  await XxPayment.findOneAndUpdate(
    { paddleTransactionId: data.id },
    {
      $setOnInsert: {
        userId,
        xxSubscriptionId: subscription?._id,
        amount: parsePaddleAmount(data?.details?.totals?.total),
        currency: data?.currency_code ?? 'USD',
        status: 'failed',
        paddleTransactionId: data.id,
        paddleSubscriptionId: data.subscription_id,
      },
    },
    { upsert: true },
  );
  await User.findByIdAndUpdate(userId, { subscriptionStatus: 'past_due' });

  await writeXxBillingLog({
    userId,
    xxSubscriptionId: subscription?._id ? String(subscription._id) : undefined,
    level: 'warning',
    eventType: 'xx.payment.failed',
    message: 'Payment failed. Please update your billing method.',
    notifyFrontend: true,
    paddleEventId,
    metadata: { transactionId: data.id },
  });
};

export const syncXxSubscriptionFromPaddle = async ({
  userId,
  transactionId,
}: {
  userId: string;
  transactionId?: string;
}) => {
  let paddleSubscription: any | null = null;

  if (transactionId) {
    const transaction = await xxPaddleRequest<any>('get', `/transactions/${transactionId}`);
    if (transaction?.data?.subscription_id) {
      const sub = await xxPaddleRequest<any>('get', `/subscriptions/${transaction.data.subscription_id}`);
      paddleSubscription = sub?.data ?? null;
    }
  }

  if (!paddleSubscription) {
    const user = await User.findById(userId).select('paddleCustomerId email').lean();
    let customerId = String((user as any)?.paddleCustomerId ?? '').trim();
    if (!customerId && (user as any)?.email) {
      const customers = await xxPaddleRequest<any>(
        'get',
        `/customers?email=${encodeURIComponent((user as any).email)}&per_page=5`,
      );
      customerId = customers?.data?.[0]?.id ?? '';
      if (customerId) await User.findByIdAndUpdate(userId, { paddleCustomerId: customerId });
    }
    if (!customerId) throw new Error('No Paddle customer found for this account.');

    const subscriptions = await xxPaddleRequest<any>(
      'get',
      `/subscriptions?customer_id=${customerId}&per_page=25`,
    );
    paddleSubscription = (subscriptions?.data ?? [])[0] ?? null;
  }

  if (!paddleSubscription) {
    return { synced: false, subscription: await getLatestXxSubscription(userId) };
  }

  await applyXxSubscriptionPayload({
    data: {
      ...paddleSubscription,
      custom_data: {
        ...(paddleSubscription.custom_data ?? {}),
        userId,
      },
    },
    eventType: 'subscription.updated',
  });

  return { synced: true, subscription: await getLatestXxSubscription(userId) };
};

export const getXxPaymentHistory = async (userId: string, page = 1, limit = 20) => {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * safeLimit;
  const [items, total] = await Promise.all([
    XxPayment.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    XxPayment.countDocuments({ userId }),
  ]);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
    noRefundPolicy: true,
  };
};

export const getXxFrontendUpdates = async ({
  userId,
  unreadOnly,
  page = 1,
  limit = 20,
}: {
  userId: string;
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
}) => {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const filter: Record<string, unknown> = { userId, notifyFrontend: true };
  if (unreadOnly) filter.isRead = false;

  const [items, total, unreadCount] = await Promise.all([
    XxBillingLog.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    XxBillingLog.countDocuments(filter),
    XxBillingLog.countDocuments({ userId, notifyFrontend: true, isRead: false }),
  ]);

  return {
    items,
    unreadCount,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
};

export const markXxFrontendUpdateRead = async (userId: string, logId: string) => {
  const item = await XxBillingLog.findOneAndUpdate(
    { _id: logId, userId, notifyFrontend: true },
    { isRead: true },
    { new: true },
  );
  if (!item) throw new Error('Update not found.');
  return item;
};

export const runXxBillingMaintenance = async () => {
  const now = new Date();

  const expiredTrials = await XxSubscription.find({
    source: 'trial',
    status: 'trialing',
    currentPeriodEnd: { $lte: now },
  });

  for (const subscription of expiredTrials) {
    subscription.status = 'expired';
    subscription.canceledAt = now;
    await subscription.save();
    await updateUserSubscriptionMirror(String(subscription.userId), subscription, 'expired');
    await writeXxBillingLog({
      userId: String(subscription.userId),
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.trial.expired',
      message: 'Your Pro trial has ended. Subscribe to continue.',
      notifyFrontend: true,
    });
  }

  const cancelAtPeriodEnd = await XxSubscription.find({
    status: { $in: ACTIVE_STATUSES },
    cancelAtPeriodEnd: true,
    cancelAt: { $lte: now },
  });

  for (const subscription of cancelAtPeriodEnd) {
    subscription.status = 'canceled';
    subscription.canceledAt = now;
    subscription.autoRenew = false;
    await subscription.save();
    await updateUserSubscriptionMirror(String(subscription.userId), subscription, 'canceled');
    await writeXxBillingLog({
      userId: String(subscription.userId),
      xxSubscriptionId: String(subscription._id),
      eventType: 'xx.subscription.canceled_at_period_end',
      message: 'Your subscription ended because auto-renew was off.',
      notifyFrontend: true,
    });
  }

  const scheduledChanges = await XxSubscription.find({
    status: { $in: ACTIVE_STATUSES },
    cancelAtPeriodEnd: false,
    paddleSubscriptionId: { $exists: true, $ne: null },
    'scheduledChange.status': 'scheduled',
  });

  for (const subscription of scheduledChanges) {
    try {
      await maybeSyncScheduledChangeToPaddle(subscription);
    } catch (error: any) {
      await writeXxBillingLog({
        userId: String(subscription.userId),
        xxSubscriptionId: String(subscription._id),
        level: 'error',
        eventType: 'xx.schedule.sync_failed',
        message: getPaddleErrorMessage(error),
        notifyFrontend: true,
        metadata: { scheduledChange: subscription.scheduledChange },
      });
    }
  }
};

export const getXxPlanForMiddleware = (tier: XxPlanTier) => getXxPlanDefinition(tier);

export const getXxSubscriptionForMiddleware = async (userId: string) => {
  const sub = await XxSubscription.findOne({
    userId,
    status: { $in: ACTIVE_STATUSES },
  })
    .sort({ activationDate: -1, createdAt: -1 })
    .lean();
  if (!sub) return null;

  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  if (periodEnd && periodEnd.getTime() <= Date.now()) return null;
  return sub;
};

export const getXxPortalUrl = async (userId: string) => {
  const subscription = await XxSubscription.findOne({
    userId,
    paddleCustomerId: { $exists: true, $ne: null },
  }).sort({ createdAt: -1 }).lean();
  const customerId = subscription?.paddleCustomerId || (await User.findById(userId).select('paddleCustomerId').lean() as any)?.paddleCustomerId;
  if (!customerId) throw new Error('No Paddle customer found for this account.');

  const body = subscription?.paddleSubscriptionId
    ? { subscription_ids: [subscription.paddleSubscriptionId] }
    : {};
  const session = await xxPaddleRequest<any>('post', `/customers/${customerId}/portal-sessions`, body);
  return {
    portalUrl: session?.data?.urls?.general?.overview ?? null,
    updatePaymentMethodUrl:
      session?.data?.urls?.subscriptions?.[0]?.update_subscription_payment_method ??
      session?.data?.urls?.general?.overview ??
      null,
  };
};
