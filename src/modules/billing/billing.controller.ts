import { Request, Response } from 'express';
import axios from 'axios';
import { Subscription } from '../../models/subscriptions';
import { Plan } from '../../models/plan';
import { Search } from '../../models/searches';
import { User } from '../../models/users';
import { Payment } from '../../models/payment';
import { PLAN_DEFINITIONS, getPlanDefinition } from './billing.constants';
import { syncPlanFromEnvByTier } from './plan-catalog.service';
import type { PlanTier } from '../../models/plan';
import type { BillingCycle, SubscriptionStatus } from '../../models/subscriptions';
import { topUpCredits, topUpAlerts } from '../../common/helpers/alert.helper';
import { evaluateSubscriptionAccess, pickEffectiveSubscription } from '../../common/helpers/subscription-access';
import {
  didBillingPeriodAdvance,
  isTierDowngrade,
  isTierUpgrade,
  shouldTopUpBalanceOnSubscriptionUpdate,
} from './subscription-change.helpers';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Returns the active/trialing plan tier for a user, defaulting to 'starter'. */
const getActivePlanTier = async (userId: string): Promise<PlanTier> => {
  const sub = await Subscription.findOne({
    userId,
    status: { $in: ['active', 'trialing'] },
  }).populate<{ planId: { tier: PlanTier } }>('planId', 'tier');
  return (sub?.planId as any)?.tier ?? 'starter';
};

/** Build the Paddle base URL from the env. */
const paddleBase = (): string =>
  process.env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

const isPaddlePriceId = (value: string) => /^pri_[a-z\d]{26}$/i.test(value.trim());

const isPaddleNotFoundError = (err: any): boolean =>
  err?.response?.data?.error?.code === 'not_found';

const isPaddleScheduledChangeProrationConflict = (err: any): boolean => {
  const detail = String(err?.response?.data?.error?.detail ?? '').toLowerCase();
  return detail.includes('scheduled change') && detail.includes('proration_billing_mode');
};

const pickBestPaddleSubscription = (subscriptions: any[]): any | undefined => {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return undefined;

  const STATUS_PRIORITY: Record<string, number> = {
    active: 0,
    trialing: 1,
    past_due: 2,
    paused: 3,
    canceled: 4,
  };

  return [...subscriptions].sort((a: any, b: any) => {
    const statusRankDiff = (STATUS_PRIORITY[a?.status] ?? 9) - (STATUS_PRIORITY[b?.status] ?? 9);
    if (statusRankDiff !== 0) return statusRankDiff;

    const aCreated = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b?.created_at ? new Date(b.created_at).getTime() : 0;
    return bCreated - aCreated;
  })[0];
};

const PADDLE_SUBSCRIPTION_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  paused: 'paused',
  past_due: 'past_due',
  canceled: 'cancelled',
};

const mapPaddleStatusToUserStatus = (
  status: SubscriptionStatus,
): 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused' | undefined => {
  if (status === 'cancelled') return 'canceled';
  if (status === 'active' || status === 'trialing' || status === 'past_due' || status === 'paused') {
    return status;
  }
  return undefined;
};

const syncLocalSubscriptionFromPaddle = async ({
  userId,
  subscriptionDocId,
  paddleSubscription,
}: {
  userId: string;
  subscriptionDocId: string;
  paddleSubscription: any;
}): Promise<boolean> => {
  const paddlePriceId = paddleSubscription?.items?.[0]?.price?.id;
  if (!paddleSubscription?.id || !paddlePriceId) {
    return false;
  }

  const plan = await Plan.findOne({
    $or: [
      { paddleMonthlyPriceId: paddlePriceId },
      { paddleAnnualPriceId: paddlePriceId },
      { paddleTrialPriceId: paddlePriceId },
    ],
  });

  if (!plan) {
    console.warn('[Paddle Subscription Update] Could not map patched subscription price to a local plan.', {
      userId,
      paddleSubscriptionId: paddleSubscription.id,
      paddlePriceId,
    });
    return false;
  }

  const status: SubscriptionStatus = PADDLE_SUBSCRIPTION_STATUS_MAP[paddleSubscription.status] ?? 'pending';
  const billingCycle: BillingCycle = paddleSubscription.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';
  const periodEnd = paddleSubscription.current_billing_period?.ends_at
    ? new Date(paddleSubscription.current_billing_period.ends_at)
    : undefined;
  const trialEnd = status === 'trialing' && paddleSubscription.next_billed_at
    ? new Date(paddleSubscription.next_billed_at)
    : undefined;
  const scheduledCancel =
    paddleSubscription.scheduled_change?.action === 'cancel' && paddleSubscription.scheduled_change?.effective_at
      ? new Date(paddleSubscription.scheduled_change.effective_at)
      : undefined;

  const setFields: Record<string, unknown> = {
    planId: plan._id,
    billingCycle,
    grantSource: status === 'trialing' ? 'trial' : 'paid',
    status,
    paddleSubscriptionId: paddleSubscription.id,
    paddleCustomerId: paddleSubscription.customer_id,
    ...(periodEnd ? { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd } : {}),
    ...(trialEnd ? { trialEndDate: trialEnd } : {}),
    ...(scheduledCancel ? { cancelDate: scheduledCancel } : {}),
    ...(!scheduledCancel ? { autoRenewReminderStages: [] } : {}),
    ...(!trialEnd ? { trialReminderStages: [] } : {}),
  };

  const unsetFields: Record<string, string> = {
    ...(!scheduledCancel ? { cancelDate: '' } : {}),
    ...(!trialEnd ? { trialEndDate: '' } : {}),
    nextPlanId: '',
    nextBillingCycle: '',
  };

  const updateDoc: Record<string, unknown> = { $set: setFields };
  if (Object.keys(unsetFields).length > 0) {
    updateDoc.$unset = unsetFields;
  }

  const subscription = await Subscription.findByIdAndUpdate(subscriptionDocId, updateDoc, { new: true });
  if (!subscription) {
    return false;
  }

  const userStatus = mapPaddleStatusToUserStatus(status);
  await User.findByIdAndUpdate(userId, {
    subscriptionId: subscription._id,
    paddleCustomerId: paddleSubscription.customer_id,
    paddleSubscriptionId: paddleSubscription.id,
    ...(userStatus ? { subscriptionStatus: userStatus } : {}),
  });

  if (status === 'active') {
    await Subscription.updateMany(
      {
        userId,
        _id: { $ne: subscription._id },
        status: { $in: ['active', 'trialing'] },
      },
      {
        $set: { status: 'cancelled', cancelDate: new Date() },
      },
    );
  }

  return true;
};

const recoverLivePaddleSubscriptionId = async (userId: string): Promise<string | null> => {
  const userDoc = await User.findById(userId).select('email paddleCustomerId').lean();
  let paddleCustomerId: string | undefined = (userDoc as any)?.paddleCustomerId;
  const email: string = (userDoc as any)?.email ?? '';

  if (!paddleCustomerId && email) {
    const customersResponse = await paddleRequest('get', `/customers?email=${encodeURIComponent(email)}&per_page=5`);
    const customers: any[] = customersResponse?.data ?? [];
    paddleCustomerId = customers[0]?.id;

    if (paddleCustomerId) {
      await User.findByIdAndUpdate(userId, { paddleCustomerId });
    }
  }

  if (!paddleCustomerId) return null;

  const subscriptionsResponse = await paddleRequest('get', `/subscriptions?customer_id=${paddleCustomerId}&per_page=25`);
  const subscriptions: any[] = subscriptionsResponse?.data ?? [];
  const bestSubscription = pickBestPaddleSubscription(subscriptions);

  return bestSubscription?.id ?? null;
};

const runPaddleMutationWithRecovery = async ({
  userId,
  localSubscriptionId,
  localSubscriptionDocId,
  actionName,
  execute,
}: {
  userId: string;
  localSubscriptionId: string;
  localSubscriptionDocId: any;
  actionName: string;
  execute: (subscriptionId: string) => Promise<void>;
}): Promise<string> => {
  try {
    await execute(localSubscriptionId);
    return localSubscriptionId;
  } catch (err: any) {
    if (!isPaddleNotFoundError(err)) {
      throw err;
    }

    console.warn(`[${actionName}] Local subscription ID not found in Paddle. Attempting customer-based recovery.`, {
      userId,
      localSubscriptionId,
      paddleEnvironment: process.env.PADDLE_ENVIRONMENT,
    });

    const recoveredSubscriptionId = await recoverLivePaddleSubscriptionId(userId);
    if (!recoveredSubscriptionId) {
      const recoveryError: any = new Error('Unable to find an active Paddle subscription for this account. Please open billing portal and retry, or contact support.');
      recoveryError.statusCode = 409;
      recoveryError.code = 'PADDLE_SUBSCRIPTION_NOT_FOUND';
      recoveryError.details = {
        paddleEnvironment: process.env.PADDLE_ENVIRONMENT,
        localSubscriptionId,
      };
      throw recoveryError;
    }

    await execute(recoveredSubscriptionId);

    await Promise.all([
      Subscription.findByIdAndUpdate(localSubscriptionDocId, { paddleSubscriptionId: recoveredSubscriptionId }),
      User.findByIdAndUpdate(userId, { paddleSubscriptionId: recoveredSubscriptionId }),
    ]);

    console.log(`[${actionName}] Recovered Paddle subscription ID from customer record.`, {
      userId,
      previousSubscriptionId: localSubscriptionId,
      recoveredSubscriptionId,
    });

    return recoveredSubscriptionId;
  }
};

const formatBillingDate = (value?: Date | string | null): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const REDACTED_LOG_KEYS = /password|token|secret|authorization|email|signature|rawbody/i;

const sanitizeForLog = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeForLog(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => ([
        key,
        REDACTED_LOG_KEYS.test(key) ? '[REDACTED]' : sanitizeForLog(entry),
      ])),
    );
  }
  return value;
};

const safeSerializeForLog = (value: unknown, maxLength = 4000): string => {
  try {
    const serialized = JSON.stringify(sanitizeForLog(value));
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}...<truncated ${serialized.length - maxLength} chars>`
      : serialized;
  } catch {
    return String(value);
  }
};

const summarizePaddlePayloadForLog = (payload: any) => {
  const data = payload?.data ?? payload;
  return {
    id: data?.id ?? null,
    status: data?.status ?? null,
    customerId: data?.customer_id ?? null,
    subscriptionId: data?.subscription_id ?? null,
    billingCycle: data?.billing_cycle?.interval ?? null,
    currentPeriodEnd: data?.current_billing_period?.ends_at ?? null,
    nextBilledAt: data?.next_billed_at ?? null,
    scheduledChange: data?.scheduled_change
      ? {
          action: data.scheduled_change.action ?? null,
          effectiveAt: data.scheduled_change.effective_at ?? null,
        }
      : null,
    items: Array.isArray(data?.items)
      ? data.items.map((item: any) => ({
          priceId: item?.price?.id ?? item?.price_id ?? null,
          quantity: Number(item?.quantity ?? 1),
        }))
      : [],
    requestId: payload?.meta?.request_id ?? null,
  };
};

const buildUpdatedSubscriptionItems = (items: any[], newPriceId: string) => {
  if (!Array.isArray(items) || items.length === 0) {
    return [{ price_id: newPriceId, quantity: 1 }];
  }

  return items.map((item: any, index: number) => ({
    price_id: index === 0 ? newPriceId : item?.price?.id,
    quantity: Number(item?.quantity) > 0 ? Number(item.quantity) : 1,
  })).filter((item) => isPaddlePriceId(String(item.price_id)));
};

const getPlanPriceIdForCycle = (tier: PlanTier, billingCycle: BillingCycle): string => {
  const definition = getPlanDefinition(tier);
  const priceId = billingCycle === 'annual'
    ? definition.paddleAnnualPriceId
    : definition.paddleMonthlyPriceId;

  if (!priceId || !isPaddlePriceId(priceId)) {
    throw new Error(`Paddle price ID is not configured for ${tier} (${billingCycle}).`);
  }

  return priceId;
};

const syncPaddleRenewalToCurrentPlan = async ({
  subscriptionId,
  currentPlanTier,
  currentBillingCycle,
  extraPatchFields,
}: {
  subscriptionId: string;
  currentPlanTier: PlanTier;
  currentBillingCycle: BillingCycle;
  extraPatchFields?: Record<string, unknown>;
}): Promise<void> => {
  const paddleSubscription = (await paddleRequest('get', `/subscriptions/${subscriptionId}`))?.data;
  const currentItems = Array.isArray(paddleSubscription?.items) ? paddleSubscription.items : [];
  const currentPriceId = getPlanPriceIdForCycle(currentPlanTier, currentBillingCycle);
  const currentPaddlePriceId = String(currentItems[0]?.price?.id ?? '');
  const patchBody: Record<string, unknown> = {
    ...(extraPatchFields ?? {}),
  };

  if (currentPaddlePriceId !== currentPriceId) {
    const nextItems = buildUpdatedSubscriptionItems(currentItems, currentPriceId);
    if (nextItems.length === 0) {
      throw new Error('Could not build Paddle subscription items for renewal reset.');
    }

    patchBody.items = nextItems;
    patchBody.proration_billing_mode = 'do_not_bill';
  }

  if (Object.keys(patchBody).length === 0) {
    return;
  }

  await paddleRequest('patch', `/subscriptions/${subscriptionId}`, patchBody);
};

/** Shared Paddle API client; throws on non-2xx with a cleaned error message. */
const paddleRequest = async (
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
) => {
  const apiKey = process.env.PADDLE_API_KEY?.trim();
  if (!apiKey) throw new Error('Paddle API key not configured.');

  console.log(`[Paddle API] ${method.toUpperCase()} ${path} | request=${safeSerializeForLog(body ?? null)}`);

  try {
    const res = await axios({
      method,
      url: `${paddleBase()}${path}`,
      data: body,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    console.log(`[Paddle API] ${method.toUpperCase()} ${path} | response=${safeSerializeForLog({
      status: res.status,
      summary: summarizePaddlePayloadForLog(res.data),
    })}`);

    return res.data;
  } catch (err: any) {
    console.error(`[Paddle API] ${method.toUpperCase()} ${path} | error=${safeSerializeForLog({
      status: err?.response?.status ?? null,
      message: err?.message ?? 'Unknown Paddle API error',
      request: body ?? null,
      response: err?.response?.data?.error ?? err?.response?.data ?? null,
    })}`);
    throw err;
  }
};

/** True when the user has never had a Paddle-managed subscription (trial eligible). */
const isTrialEligible = async (userId: string): Promise<boolean> => {
  const previous = await Subscription.findOne({
    userId,
    paddleSubscriptionId: { $exists: true, $ne: null },
  }).lean();
  return !previous;
};

/**
 * Look up or create a Paddle customer for the given user.
 * Caches the customer ID on the User document.
 */
const getOrCreatePaddleCustomer = async (
  userId: string,
  email: string,
  name: string,
): Promise<string> => {
  const userDoc = await User.findById(userId).select('paddleCustomerId').lean();
  const cachedCustomerId = (userDoc as any)?.paddleCustomerId as string | undefined;

  if (cachedCustomerId) {
    try {
      await paddleRequest('get', `/customers/${cachedCustomerId}`);
      return cachedCustomerId;
    } catch (err: any) {
      if (!isPaddleNotFoundError(err)) {
        throw err;
      }

      // Cached customer ID can become stale across environments (sandbox/production)
      // or if it no longer exists. Clear and recover via email lookup/create.
      console.warn('[Paddle Checkout] Cached paddleCustomerId not found; recovering via email lookup.', {
        userId,
        cachedCustomerId,
        paddleEnvironment: process.env.PADDLE_ENVIRONMENT,
      });
      await User.findByIdAndUpdate(userId, { $unset: { paddleCustomerId: '' } });
    }
  }

  const searchData = await paddleRequest('get', `/customers?email=${encodeURIComponent(email)}&per_page=5`);
  const existing: any[] = searchData?.data ?? [];
  if (existing.length > 0) {
    const paddleCustomerId: string = existing[0].id;
    await User.findByIdAndUpdate(userId, { paddleCustomerId });
    return paddleCustomerId;
  }
  const createData = await paddleRequest('post', '/customers', { email, name });
  const paddleCustomerId: string | undefined = createData?.data?.id;
  if (!paddleCustomerId) throw new Error('Paddle did not return a customer ID when creating customer.');
  await User.findByIdAndUpdate(userId, { paddleCustomerId });
  return paddleCustomerId;
};

// ─── Controllers ───────────────────────────────────────────────────────────

/** GET /billing/plans — return all plan definitions (no auth required) */
export const getPlans = async (_req: Request, res: Response) => {
  res.json({ success: true, plans: PLAN_DEFINITIONS });
};

/**
 * GET /billing/subscription — return the authenticated user's current
 * subscription status + active plan info.
 */
export const getSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const [subscriptions, userDoc] = await Promise.all([
      Subscription.find({ userId })
        .sort({ activationDate: -1, createdAt: -1 })
        .populate('planId', 'tier name monthlyPrice annualPrice imageUploadLimit alertLimit pdfEnabled trialDays')
        .populate('nextPlanId', 'tier name monthlyPrice annualPrice imageUploadLimit alertLimit pdfEnabled trialDays')
        .lean(),
      User.findById(userId)
        .select('permanentPdfAccess credits subscriptionStatus paddleSubscriptionId')
        .lean(),
    ]);

    const sub = pickEffectiveSubscription(subscriptions as any[], {
      preferredSubscriptionId: (userDoc as { paddleSubscriptionId?: string | null } | null)?.paddleSubscriptionId,
    });

    const subStatus = sub?.status ?? null;
    const {
      effectiveStatus,
      hasAccess: hasSubAccess,
      grantSource,
      periodExpired,
      isTrialing,
      trialEndsAt,
    } = evaluateSubscriptionAccess(sub as any, userDoc?.subscriptionStatus ?? null);

    const tier: PlanTier = hasSubAccess
      ? ((sub?.planId as any)?.tier ?? 'starter')
      : 'starter';
    const planDef = getPlanDefinition(tier);
    const pdfEnabled = planDef.pdfEnabled || (userDoc?.permanentPdfAccess ?? false);
    const autoRenewEnabled =
      !!sub &&
      !sub.cancelDate &&
      ['active', 'trialing', 'past_due'].includes(String(sub.status ?? ''));
    const nextPlanDoc = sub?.nextPlanId as any;
    const nextPlanTier: PlanTier | null = autoRenewEnabled
      ? ((nextPlanDoc?.tier as PlanTier | undefined) ?? ((sub?.planId as any)?.tier as PlanTier | undefined) ?? tier)
      : null;
    const nextPlanDef = nextPlanTier ? getPlanDefinition(nextPlanTier) : null;
    const nextPlan = nextPlanDef
      ? { ...nextPlanDef, pdfEnabled: nextPlanDef.pdfEnabled || (userDoc?.permanentPdfAccess ?? false) }
      : null;
    const nextBillingCycle = autoRenewEnabled ? (sub?.nextBillingCycle ?? sub?.billingCycle ?? null) : null;
    const hasScheduledPlanChange =
      !!sub &&
      autoRenewEnabled &&
      (
        (!!nextPlanDoc?._id && String(nextPlanDoc._id) !== String((sub?.planId as any)?._id)) ||
        (!!nextBillingCycle && nextBillingCycle !== sub.billingCycle)
      );
    const isTrial = isTrialing || (grantSource === 'trial' && hasSubAccess && !periodExpired);

    const trialDaysLeft = isTrial && trialEndsAt
      ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0;

    // Images used this calendar month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const imagesUsedThisMonth = await Search.countDocuments({
      userId,
      date: { $gte: monthStart },
    });

    res.json({
      success: true,
      subscription: sub
        ? {
            id: (sub as any)._id,
            status: effectiveStatus,
            paddleStatus: userDoc?.subscriptionStatus ?? null,
            hasAccess: hasSubAccess,
            billingCycle: sub.billingCycle,
            grantSource,
            isTrial,
            isTrialing,
            isPastDue: subStatus === 'past_due',
            trialEndsAt,
            trialDaysLeft,
            activationDate: sub.activationDate,
            currentPeriodEnd: sub.currentPeriodEnd,
            nextBillingDate: sub.nextBillingDate,
            cancelDate: sub.cancelDate,
            autoRenewEnabled,
            nextPlan,
            nextBillingCycle,
            hasScheduledPlanChange,
            planChangeEffectiveAt: hasScheduledPlanChange
              ? (sub.nextBillingDate ?? sub.currentPeriodEnd ?? null)
              : null,
            paddleManaged: !!(sub as any).paddleSubscriptionId,
          }
        : null,
      plan: { ...planDef, pdfEnabled },
      credits: userDoc?.credits ?? 0,
      usage: {
        imagesUsedThisMonth,
        imageUploadLimit: planDef.imageUploadLimit,
        alertLimit: planDef.alertLimit,
        pdfEnabled,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

/**
 * GET /billing/plan-limits — lightweight endpoint for the frontend to
 * know if results should be blurred without loading the full subscription.
 */
export const getPlanLimits = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const [tier, userDoc] = await Promise.all([
      getActivePlanTier(userId),
      User.findById(userId).select('permanentPdfAccess').lean(),
    ]);
    const planDef    = getPlanDefinition(tier);
    const pdfEnabled = planDef.pdfEnabled || (userDoc?.permanentPdfAccess ?? false);
    res.json({
      success: true,
      tier,
      alertLimit:         planDef.alertLimit,
      imageUploadLimit:   planDef.imageUploadLimit,
      pdfEnabled,
      permanentPdfAccess: userDoc?.permanentPdfAccess ?? false,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

/**
 * POST /billing/subscribe — admin/testing only. Creates a subscription directly
 * without a Paddle payment. Do NOT expose this on public routes.
 * The production flow is: POST /billing/paddle/checkout → user pays → webhook activates subscription.
 */
export const subscribe = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const { tier, billingCycle } = req.body as { tier: PlanTier; billingCycle: BillingCycle };

    if (!['starter', 'pro', 'premium'].includes(tier)) {
      return res.status(400).json({ success: false, message: 'Invalid plan tier.' });
    }
    if (!['monthly', 'annual'].includes(billingCycle)) {
      return res.status(400).json({ success: false, message: 'Invalid billing cycle.' });
    }

    const def = getPlanDefinition(tier);
    const plan = await syncPlanFromEnvByTier(tier);

    // Carry over is automatic — user's credits/alertsRemaining balance persists.
    // Subscribing to a new plan simply adds the plan's quota on top.
    await Subscription.updateMany(
      { userId, status: { $in: ['active', 'trialing'] } },
      { status: 'cancelled', cancelDate: new Date() },
    );

    const now = new Date();
    const periodEnd = new Date(now);
    billingCycle === 'annual'
      ? periodEnd.setFullYear(periodEnd.getFullYear() + 1)
      : periodEnd.setMonth(periodEnd.getMonth() + 1);

    const sub = await Subscription.create({
      userId, planId: plan._id, billingCycle, grantSource: 'paid',
      status: 'active', activationDate: now,
      currentPeriodEnd: periodEnd, nextBillingDate: periodEnd,
    });

    // Top up the user's monitoring credits and alert quota
    await Promise.all([
      topUpCredits(userId, def.imageUploadLimit),
      topUpAlerts(userId, def.alertLimit),
    ]);

    res.status(201).json({
      success: true,
      message: `Subscribed to ${def.name} (${billingCycle}) successfully.`,
      subscriptionId: sub._id,
      plan: def,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

/**
 * POST /billing/paddle/checkout — create a Paddle checkout transaction and
 * return the hosted checkout URL.
 *
 * Body: { tier, billingCycle, withTrial?, discountId? }
 *   OR  { priceId, discountId? }
 *
 * Trial logic (Paddle-native):
 *   If withTrial is not explicitly false AND the plan has a paddleTrialPriceId configured
 *   AND the user has never had a Paddle-managed subscription → use the trial price.
 *   Trial period length is set on the Paddle Price in the dashboard (configure via
 *   PADDLE_<TIER>_TRIAL_PRICE_ID in env).
 */
export const createPaddleCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    let { priceId, tier, billingCycle, withTrial, discountId } = req.body;

    if (!priceId && tier) {
      const def = getPlanDefinition(tier as PlanTier);

      const hasActiveLocalTrial = !!(await Subscription.findOne({
        userId,
        grantSource: 'trial',
        status: { $in: ['active', 'trialing'] },
        $or: [
          { paddleSubscriptionId: { $exists: false } },
          { paddleSubscriptionId: null },
        ],
      }).lean());

      // Determine if we should use the Paddle-native trial price
      const offerTrial =
        withTrial !== false &&          // caller didn't opt out
        def.trialDays > 0 &&            // plan supports a trial
        !!def.paddleTrialPriceId &&      // trial price configured in env
        (await isTrialEligible(userId)) && // user hasn't already been through Paddle
        !hasActiveLocalTrial;             // don't stack a second trial over local trial access

      if (offerTrial) {
        priceId = def.paddleTrialPriceId;
      } else {
        priceId = billingCycle === 'annual' ? def.paddleAnnualPriceId : def.paddleMonthlyPriceId;
      }

      if (!priceId) {
        return res.status(404).json({
          success: false,
          message: `No Paddle price ID configured for plan "${tier}" (${billingCycle ?? 'monthly'}). ` +
            `Check PADDLE_${String(tier).toUpperCase()}_${billingCycle === 'annual' ? 'ANNUAL' : 'MONTHLY'}_PRICE_ID in env.`,
        });
      }
    }

    if (!priceId) {
      return res.status(400).json({ success: false, message: 'priceId (or tier) is required.' });
    }

    if (!isPaddlePriceId(String(priceId))) {
      return res.status(400).json({
        success: false,
        message: `Invalid Paddle price ID "${String(priceId)}". Expected a Price ID like pri_xxxxxxxxxxxxxxxxxxxxxxxxxx (not a Product ID like pro_...).`,
      });
    }

    const userForCheckout = await User.findById(userId).select('email name').lean();
    const userEmail: string = (userForCheckout as any)?.email ?? '';
    const userName: string  = (userForCheckout as any)?.name  ?? '';
    const paddleCustomerId = userEmail
      ? await getOrCreatePaddleCustomer(userId, userEmail, userName)
      : undefined;

    const body: Record<string, unknown> = {
      items:       [{ price_id: priceId, quantity: 1 }],
      custom_data: { userId },
    };
    if (paddleCustomerId) body.customer_id = paddleCustomerId;
    if (discountId) body.discount_id = discountId;

    console.log(`[Paddle Checkout] env=${process.env.PADDLE_ENVIRONMENT} priceId=${priceId} userId=${userId} customerId=${paddleCustomerId ?? 'none'} discount=${discountId ?? 'none'}`);

    const data = await paddleRequest('post', '/transactions', body);
    const txn = data?.data;
    const checkoutUrl: string | undefined = txn?.checkout?.url;
    const transactionId: string | undefined = txn?.id;

    if (!transactionId) {
      return res.status(500).json({
        success: false,
        message: 'Paddle did not return a transaction ID.',
        debug: { txnStatus: txn?.status },
      });
    }

    // transactionId → use with Paddle.Checkout.open({ transactionId }) for overlay/inline
    // checkoutUrl   → use for redirect-based hosted checkout
    res.json({ success: true, transactionId, checkoutUrl: checkoutUrl ?? null });
  } catch (err: any) {
    const paddleError = err?.response?.data;
    console.error('[Paddle Checkout Error]', JSON.stringify(paddleError ?? err?.message, null, 2));
    const msg = paddleError?.error?.detail || paddleError?.error?.code || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg, paddleError: paddleError?.error ?? null });
  }
};

/**
 * PATCH /billing/subscription — upgrade or downgrade the active Paddle subscription.
 * Body: { tier: PlanTier, billingCycle?: BillingCycle }
 * Upgrades apply immediately. Downgrades are scheduled for the next billing period.
 */
export const updateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const { tier, billingCycle } = req.body as { tier: PlanTier; billingCycle?: BillingCycle };

    if (!['starter', 'pro', 'premium'].includes(tier)) {
      return res.status(400).json({ success: false, message: 'Invalid plan tier.' });
    }

    const sub = await Subscription.findOne({ userId, status: { $in: ['active', 'trialing'] } });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No active subscription found.' });
    }
    if (!sub.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Subscription is not managed by Paddle. Use /billing/cancel and re-subscribe.' });
    }

    const targetCycle: BillingCycle = billingCycle ?? (sub.billingCycle as BillingCycle);
    const def = getPlanDefinition(tier);
    const [currentPlan, targetPlan] = await Promise.all([
      Plan.findById(sub.planId).select('tier name').lean(),
      syncPlanFromEnvByTier(tier),
    ]);

    if (!currentPlan) {
      return res.status(422).json({ success: false, message: 'Current subscription plan could not be resolved.' });
    }

    const currentTier = currentPlan.tier as PlanTier;
    const isImmediateUpgrade = isTierUpgrade(currentTier, targetPlan.tier as PlanTier);

    if (sub.cancelDate && !isImmediateUpgrade) {
      return res.status(409).json({
        success: false,
        message: 'Auto-renew is off. Resume auto-renew before changing the renewal plan.',
        code: 'AUTO_RENEW_DISABLED',
      });
    }

    const newPriceId = targetCycle === 'annual' ? def.paddleAnnualPriceId : def.paddleMonthlyPriceId;

    if (!newPriceId) {
      return res.status(404).json({ success: false, message: `No Paddle price ID for plan "${tier}" (${targetCycle}).` });
    }

    if (!isPaddlePriceId(String(newPriceId))) {
      return res.status(400).json({
        success: false,
        message: `Invalid Paddle price ID configured for ${tier} (${targetCycle}): "${String(newPriceId)}". Use Paddle Price IDs (pri_), not Product IDs (pro_).`,
      });
    }

    const hasPendingPlanChange =
      (!!sub.nextPlanId && String(sub.nextPlanId) !== String(sub.planId)) ||
      (!!sub.nextBillingCycle && sub.nextBillingCycle !== sub.billingCycle);
    const currentRenewalPlanId = hasPendingPlanChange && sub.nextPlanId
      ? String(sub.nextPlanId)
      : String(sub.planId);
    const currentRenewalCycle = hasPendingPlanChange
      ? (sub.nextBillingCycle ?? sub.billingCycle)
      : sub.billingCycle;

    if (String(targetPlan._id) === currentRenewalPlanId && targetCycle === currentRenewalCycle) {
      return res.json({
        success: true,
        syncedLocally: false,
        changeTiming: hasPendingPlanChange ? 'next_billing_period' : 'none',
        effectiveAt: hasPendingPlanChange ? (sub.nextBillingDate ?? sub.currentPeriodEnd ?? null) : null,
        message: hasPendingPlanChange
          ? `Your renewal is already set to ${targetPlan.name} (${targetCycle}).`
          : `You are already on ${targetPlan.name} (${targetCycle}).`,
      });
    }

    const isDowngrade = isTierDowngrade(currentTier, targetPlan.tier as PlanTier);
    const shouldDeferToNextBillingPeriod =
      isDowngrade ||
      (hasPendingPlanChange && !isTierUpgrade(currentTier, targetPlan.tier as PlanTier));
    const isRevertingToCurrentRenewal =
      hasPendingPlanChange &&
      String(targetPlan._id) === String(sub.planId) &&
      targetCycle === sub.billingCycle;

    let paddleSubscriptionId = sub.paddleSubscriptionId;
    let currentSubscriptionResponse: any;

    try {
      currentSubscriptionResponse = await paddleRequest('get', `/subscriptions/${paddleSubscriptionId}`);
    } catch (err: any) {
      if (!isPaddleNotFoundError(err)) {
        throw err;
      }

      console.warn('[Paddle Subscription Update] Local subscription ID not found in Paddle. Attempting customer-based recovery.', {
        userId,
        paddleSubscriptionId,
        paddleEnvironment: process.env.PADDLE_ENVIRONMENT,
      });

      const recoveredSubscriptionId = await recoverLivePaddleSubscriptionId(userId);

      if (!recoveredSubscriptionId) {
        return res.status(409).json({
          success: false,
          message: 'Unable to find an active Paddle subscription for this account. Please open billing portal and retry, or contact support.',
          code: 'PADDLE_SUBSCRIPTION_NOT_FOUND',
          details: {
            paddleEnvironment: process.env.PADDLE_ENVIRONMENT,
            localSubscriptionId: paddleSubscriptionId,
          },
        });
      }

      paddleSubscriptionId = recoveredSubscriptionId;
      currentSubscriptionResponse = await paddleRequest('get', `/subscriptions/${paddleSubscriptionId}`);

      await Promise.all([
        Subscription.findByIdAndUpdate(sub._id, { paddleSubscriptionId }),
        User.findByIdAndUpdate(userId, { paddleSubscriptionId }),
      ]);

      console.log('[Paddle Subscription Update] Recovered Paddle subscription ID from customer record.', {
        userId,
        previousSubscriptionId: sub.paddleSubscriptionId,
        recoveredSubscriptionId: paddleSubscriptionId,
      });
    }

    const currentPaddleSubscription = currentSubscriptionResponse?.data;
    const currentItems = Array.isArray(currentPaddleSubscription?.items) ? currentPaddleSubscription.items : [];

    if (currentItems.length === 0) {
      console.error('[Paddle Subscription Update] No subscription items found', {
        subscriptionId: paddleSubscriptionId,
        userId,
      });
    }

    const nextItems = buildUpdatedSubscriptionItems(currentItems, String(newPriceId));

    if (nextItems.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Could not build Paddle subscription items for update.',
      });
    }

    const deferredProrationBillingMode = hasPendingPlanChange
      ? 'do_not_bill'
      : 'full_next_billing_period';
    const initialProrationBillingMode = shouldDeferToNextBillingPeriod
      ? deferredProrationBillingMode
      : 'prorated_immediately';

    let updatedSubscriptionResponse: any;
    try {
      updatedSubscriptionResponse = await paddleRequest('patch', `/subscriptions/${paddleSubscriptionId}`, {
        items: nextItems,
        proration_billing_mode: initialProrationBillingMode,
      });
    } catch (err: any) {
      const shouldRetryWithoutBilling =
        shouldDeferToNextBillingPeriod &&
        initialProrationBillingMode === 'full_next_billing_period' &&
        isPaddleScheduledChangeProrationConflict(err);

      if (!shouldRetryWithoutBilling) {
        throw err;
      }

      console.warn('[Paddle Subscription Update] Retrying deferred change without billing because Paddle reports an existing scheduled change.', {
        userId,
        paddleSubscriptionId,
        initialProrationBillingMode,
      });

      updatedSubscriptionResponse = await paddleRequest('patch', `/subscriptions/${paddleSubscriptionId}`, {
        items: nextItems,
        proration_billing_mode: 'do_not_bill',
      });
    }

    if (shouldDeferToNextBillingPeriod) {
      if (isRevertingToCurrentRenewal) {
        await Subscription.findByIdAndUpdate(sub._id, {
          $unset: { nextPlanId: '', nextBillingCycle: '' },
        });
      } else {
        await Subscription.findByIdAndUpdate(sub._id, {
          $set: { nextPlanId: targetPlan._id, nextBillingCycle: targetCycle },
        });
      }

      const effectiveAt = sub.nextBillingDate ?? sub.currentPeriodEnd ?? null;
      const effectiveAtText = formatBillingDate(effectiveAt);

      return res.json({
        success: true,
        syncedLocally: false,
        changeTiming: 'next_billing_period',
        effectiveAt,
        message: isRevertingToCurrentRenewal
          ? `Renewal plan reset. ${currentPlan.name} (${sub.billingCycle}) will continue${effectiveAtText ? ` on ${effectiveAtText}` : ' at the next billing date'}.`
          : `Downgrade to ${def.name} (${targetCycle}) scheduled${effectiveAtText ? ` for ${effectiveAtText}` : ' for the next billing date'}. Your current ${currentPlan.name} plan, access, and remaining credits stay unchanged until then.`,
        paddleSubscriptionId: updatedSubscriptionResponse?.data?.id ?? paddleSubscriptionId,
      });
    }

    let syncedLocally = false;
    try {
      const updatedPaddleSubscription = updatedSubscriptionResponse?.data
        ?? (await paddleRequest('get', `/subscriptions/${paddleSubscriptionId}`))?.data;
      syncedLocally = await syncLocalSubscriptionFromPaddle({
        userId,
        subscriptionDocId: String(sub._id),
        paddleSubscription: updatedPaddleSubscription,
      });
    } catch (syncErr: any) {
      console.error('[Paddle Subscription Update] Local sync after patch failed.', JSON.stringify(syncErr?.response?.data ?? syncErr?.message, null, 2));
    }

    res.json({
      success: true,
      syncedLocally,
      changeTiming: 'immediate',
      effectiveAt: new Date(),
      message: `Subscription updated to ${def.name} (${targetCycle}). Changes take effect immediately.${sub.cancelDate ? ' Auto-renew remains off until the current billing period ends.' : ''}`,
    });
  } catch (err: any) {
    console.error('[Paddle Subscription Update Error]', JSON.stringify(err?.response?.data ?? err?.message, null, 2));
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    const status = isPaddleNotFoundError(err) ? 409 : 500;
    res.status(status).json({
      success: false,
      message: msg,
      code: isPaddleNotFoundError(err) ? 'PADDLE_SUBSCRIPTION_NOT_FOUND' : undefined,
      details: isPaddleNotFoundError(err)
        ? { paddleEnvironment: process.env.PADDLE_ENVIRONMENT }
        : undefined,
    });
  }
};

/**
 * POST /billing/pause — pause the active Paddle subscription at end of current period.
 */
export const pauseSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const sub = await Subscription.findOne({ userId, status: 'active' });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No active subscription found.' });
    }
    if (!sub.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Subscription is not managed by Paddle.' });
    }

    await paddleRequest('post', `/subscriptions/${sub.paddleSubscriptionId}/pause`, {
      effective_from: 'next_billing_period',
    });

    // subscription.paused webhook will update the local record.
    res.json({ success: true, message: 'Subscription will be paused at the end of the current billing period.' });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg });
  }
};

/**
 * POST /billing/resume — resume a paused Paddle subscription immediately.
 */
export const resumeSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const sub = await Subscription.findOne({ userId, status: 'paused' });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No paused subscription found.' });
    }
    if (!sub.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Subscription is not managed by Paddle.' });
    }

    await runPaddleMutationWithRecovery({
      userId,
      localSubscriptionId: sub.paddleSubscriptionId,
      localSubscriptionDocId: sub._id,
      actionName: 'Paddle Resume Subscription',
      execute: async (subscriptionId: string) => {
        await paddleRequest('post', `/subscriptions/${subscriptionId}/resume`, {
          effective_from: 'immediately',
        });
      },
    });

    // subscription.resumed webhook will update the local record.
    res.json({ success: true, message: 'Subscription resumed. Access will be restored shortly.' });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    const status = Number(err?.statusCode) || (isPaddleNotFoundError(err) ? 409 : 500);
    res.status(status).json({
      success: false,
      message: msg,
      code: err?.code || (isPaddleNotFoundError(err) ? 'PADDLE_SUBSCRIPTION_NOT_FOUND' : undefined),
      details: err?.details || (isPaddleNotFoundError(err) ? { paddleEnvironment: process.env.PADDLE_ENVIRONMENT } : undefined),
    });
  }
};

/**
 * POST /billing/resume-auto-renew — remove a scheduled end-of-period cancellation
 * so the subscription renews automatically again.
 */
export const resumeAutoRenew = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const sub = await Subscription.findOne({
      userId,
      status: { $in: ['active', 'trialing', 'past_due'] },
    });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No renewable subscription found.' });
    }
    if (!sub.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Subscription is not managed by Paddle.' });
    }

    const currentPlan = await Plan.findById(sub.planId).select('tier').lean();
    const currentPlanTier = currentPlan?.tier as PlanTier | undefined;
    if (!currentPlanTier) {
      return res.status(409).json({
        success: false,
        message: 'Current plan configuration could not be resolved.',
        code: 'PLAN_NOT_FOUND',
      });
    }

    await runPaddleMutationWithRecovery({
      userId,
      localSubscriptionId: sub.paddleSubscriptionId,
      localSubscriptionDocId: sub._id,
      actionName: 'Paddle Resume Auto Renew',
      execute: async (subscriptionId: string) => {
        await syncPaddleRenewalToCurrentPlan({
          subscriptionId,
          currentPlanTier,
          currentBillingCycle: sub.billingCycle,
          extraPatchFields: { scheduled_change: null },
        });
      },
    });

    // Reflect the expected state immediately while webhook confirmation arrives.
    await Subscription.findByIdAndUpdate(sub._id, {
      $unset: { cancelDate: '', nextPlanId: '', nextBillingCycle: '' },
      $set: { autoRenewReminderStages: [] },
    });

    res.json({ success: true, message: 'Auto-renew resumed. Your subscription will renew at the next billing date.' });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    const status = Number(err?.statusCode) || (isPaddleNotFoundError(err) ? 409 : 500);
    res.status(status).json({
      success: false,
      message: msg,
      code: err?.code || (isPaddleNotFoundError(err) ? 'PADDLE_SUBSCRIPTION_NOT_FOUND' : undefined),
      details: err?.details || (isPaddleNotFoundError(err) ? { paddleEnvironment: process.env.PADDLE_ENVIRONMENT } : undefined),
    });
  }
};

/**
 * GET /billing/payment-method — return a Paddle customer portal URL so the
 * user can update their payment method directly in the Paddle-hosted portal.
 */
export const getUpdatePaymentUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    // paddleCustomerId is stored on the Subscription when Paddle fires the webhook,
    // or on the User document. Check both.
    const [sub, userDoc] = await Promise.all([
      Subscription.findOne({
        userId,
        status: { $in: ['active', 'trialing', 'paused', 'past_due'] },
        paddleSubscriptionId: { $exists: true },
      }).lean(),
      User.findById(userId).select('paddleCustomerId').lean(),
    ]);

    const paddleCustomerId = (sub as any)?.paddleCustomerId || (userDoc as any)?.paddleCustomerId;
    if (!paddleCustomerId) {
      return res.status(404).json({ success: false, message: 'No Paddle customer record found. Please subscribe first.' });
    }

    const paddleSubId: string | undefined = (sub as any)?.paddleSubscriptionId;
    const data = await paddleRequest('post', `/customers/${paddleCustomerId}/portal-sessions`, paddleSubId ? { subscription_ids: [paddleSubId] } : {});
    const subEntry = data?.data?.urls?.subscriptions?.[0];
    const portalUrl: string | undefined =
      subEntry?.update_subscription_payment_method ?? data?.data?.urls?.general?.overview;

    if (!portalUrl) {
      return res.status(500).json({ success: false, message: 'Could not retrieve portal URL from Paddle.' });
    }

    // Keep both keys for backward compatibility with existing frontend callers.
    res.json({ success: true, portalUrl, updateUrl: portalUrl });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg });
  }
};

/**
 * GET /billing/portal — return a Paddle customer portal URL focused on account overview.
 * Users can view invoices/receipts and manage billing from the hosted portal.
 */
export const getBillingPortalUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const [sub, userDoc] = await Promise.all([
      Subscription.findOne({
        userId,
        status: { $in: ['active', 'trialing', 'paused', 'past_due', 'cancelled'] },
        paddleSubscriptionId: { $exists: true },
      }).lean(),
      User.findById(userId).select('paddleCustomerId').lean(),
    ]);

    const paddleCustomerId = (sub as any)?.paddleCustomerId || (userDoc as any)?.paddleCustomerId;
    if (!paddleCustomerId) {
      return res.status(404).json({ success: false, message: 'No Paddle customer record found. Please subscribe first.' });
    }

    const data = await paddleRequest('post', `/customers/${paddleCustomerId}/portal-sessions`, {});
    const portalUrl: string | undefined = data?.data?.urls?.general?.overview;

    if (!portalUrl) {
      return res.status(500).json({ success: false, message: 'Could not retrieve billing portal URL from Paddle.' });
    }

    res.json({ success: true, portalUrl });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg });
  }
};

/**
 * GET /billing/history — return paginated payment history for the authenticated user.
 */
export const getBillingHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Payment.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('amount currency status paddleTransactionId paddleSubscriptionId createdAt')
        .lean(),
      Payment.countDocuments({ userId }),
    ]);

    res.json({
      success: true,
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

/**
 * POST /billing/cancel — cancel the user's active or trialing subscription.
 *
 * For Paddle-managed subscriptions: requests cancellation at end of billing period
 * via Paddle API, then waits for the subscription.canceled webhook to update the
 * local DB (no optimistic local update to avoid state mismatch).
 *
 * For non-Paddle subscriptions (trial grants, referral grants): updates locally.
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const sub = await Subscription.findOne({
      userId,
      status: { $in: ['active', 'trialing', 'past_due'] },
    });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No active subscription found.' });
    }

    if (sub.paddleSubscriptionId) {
      const currentPlan = await Plan.findById(sub.planId).select('tier').lean();
      const currentPlanTier = currentPlan?.tier as PlanTier | undefined;
      if (!currentPlanTier) {
        return res.status(409).json({
          success: false,
          message: 'Current plan configuration could not be resolved.',
          code: 'PLAN_NOT_FOUND',
        });
      }

      const hasPendingPlanChange =
        (!!sub.nextPlanId && String(sub.nextPlanId) !== String(sub.planId)) ||
        (!!sub.nextBillingCycle && sub.nextBillingCycle !== sub.billingCycle);

      console.log(`[Billing] cancelSubscription | ${safeSerializeForLog({
        userId,
        subscriptionId: sub._id,
        paddleSubscriptionId: sub.paddleSubscriptionId,
        planId: sub.planId,
        nextPlanId: sub.nextPlanId ?? null,
        billingCycle: sub.billingCycle,
        nextBillingCycle: sub.nextBillingCycle ?? null,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        nextBillingDate: sub.nextBillingDate ?? null,
        hasPendingPlanChange,
      })}`);

      // Paddle-managed: send cancel request; let the webhook confirm cancellation.
      await runPaddleMutationWithRecovery({
        userId,
        localSubscriptionId: sub.paddleSubscriptionId,
        localSubscriptionDocId: sub._id,
        actionName: 'Paddle Cancel Subscription',
        execute: async (subscriptionId: string) => {
          await syncPaddleRenewalToCurrentPlan({
            subscriptionId,
            currentPlanTier,
            currentBillingCycle: sub.billingCycle,
            extraPatchFields: hasPendingPlanChange ? { scheduled_change: null } : undefined,
          });

          await paddleRequest('post', `/subscriptions/${subscriptionId}/cancel`, {
            effective_from: 'next_billing_period',
          });
        },
      });

      const effectiveAt = sub.nextBillingDate ?? sub.currentPeriodEnd ?? null;
      const updateDoc: Record<string, any> = {
        $unset: { nextPlanId: '', nextBillingCycle: '' },
      };
      if (effectiveAt) {
        updateDoc.$set = { cancelDate: effectiveAt };
      }

      await Subscription.findByIdAndUpdate(sub._id, updateDoc);

      const effectiveAtText = formatBillingDate(effectiveAt);
      return res.json({
        success: true,
        effectiveAt,
        message: `Auto-renew turned off. Your subscription stays active${effectiveAtText ? ` until ${effectiveAtText}` : ' until the end of the current billing period'}. No next plan is scheduled.${hasPendingPlanChange ? ' Any scheduled plan change was canceled.' : ''}`,
      });
    }

    // Non-Paddle (trial / referral grant): no webhook will come, update locally.
    await Subscription.findByIdAndUpdate(sub._id, {
      $set: { status: 'cancelled', cancelDate: new Date() },
      $unset: { nextPlanId: '', nextBillingCycle: '' },
    });
    await User.findByIdAndUpdate(userId, { subscriptionId: null });
    res.json({ success: true, message: 'Subscription cancelled successfully.' });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    const status = Number(err?.statusCode) || (isPaddleNotFoundError(err) ? 409 : 500);
    res.status(status).json({
      success: false,
      message: msg,
      code: err?.code || (isPaddleNotFoundError(err) ? 'PADDLE_SUBSCRIPTION_NOT_FOUND' : undefined),
      details: err?.details || (isPaddleNotFoundError(err) ? { paddleEnvironment: process.env.PADDLE_ENVIRONMENT } : undefined),
    });
  }
};

/**
 * POST /billing/sync — pull the latest subscription state from Paddle and
 * update the local DB. Use this after checkout when webhooks haven't fired yet
 * (e.g. local dev without ngrok). Safe to call repeatedly — fully idempotent.
 */
export const syncSubscriptionFromPaddle = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const { transactionId } = req.body as { transactionId?: string };

    let paddleCustomerId: string | undefined;
    let paddleSub: any;

    // Path 1: transactionId provided
    if (transactionId) {
      const txData = await paddleRequest('get', `/transactions/${transactionId}`);
      const tx = txData?.data;
      if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found in Paddle.' });
      if (tx.customer_id) {
        paddleCustomerId = tx.customer_id;
        await User.findByIdAndUpdate(userId, { paddleCustomerId });
      }
      if (tx.subscription_id) {
        const subData = await paddleRequest('get', `/subscriptions/${tx.subscription_id}`);
        paddleSub = subData?.data;
      }
    }

    // Path 2/3: use cached paddleCustomerId or fall back to email
    if (!paddleSub) {
      if (!paddleCustomerId) {
        const userDoc = await User.findById(userId).select('paddleCustomerId email').lean();
        paddleCustomerId = (userDoc as any)?.paddleCustomerId;
        if (!paddleCustomerId) {
          const userEmail: string = (userDoc as any)?.email ?? '';
          if (!userEmail) return res.status(404).json({ success: false, message: 'No Paddle customer found for this account. Complete a checkout first.' });
          const searchData = await paddleRequest('get', `/customers?email=${encodeURIComponent(userEmail)}&per_page=5`);
          const customers: any[] = searchData?.data ?? [];
          if (!customers.length) return res.status(404).json({ success: false, message: 'No Paddle customer found for this account. Complete a checkout first.' });
          paddleCustomerId = customers[0].id;
          await User.findByIdAndUpdate(userId, { paddleCustomerId });
        }
      }
      const subListData = await paddleRequest('get', `/subscriptions?customer_id=${paddleCustomerId}&per_page=10`);
      const subscriptions: any[] = subListData?.data ?? [];
      if (!subscriptions.length) return res.json({ success: true, synced: false, message: 'No subscriptions found in Paddle for this customer.' });
      const STATUS_PRIORITY: Record<string, number> = { active: 0, trialing: 1, paused: 2, past_due: 3, canceled: 4 };
      paddleSub = subscriptions.sort((a: any, b: any) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9))[0];
    }

    const paddlePriceId = paddleSub.items?.[0]?.price?.id;
    if (!paddlePriceId) {
      return res.status(422).json({ success: false, message: 'Could not read price ID from Paddle subscription.' });
    }

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
        { paddleTrialPriceId:   paddlePriceId },
      ],
    });
    if (!plan) {
      return res.status(422).json({ success: false, message: `No local plan matched price ID: ${paddlePriceId}` });
    }

    const PADDLE_STATUS_MAP: Record<string, string> = {
      active:   'active',
      trialing: 'trialing',
      paused:   'paused',
      past_due: 'past_due',
      canceled: 'cancelled',
    };
    const status = PADDLE_STATUS_MAP[paddleSub.status] ?? 'pending';
    const billingCycle: BillingCycle = paddleSub.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';
    const periodEnd = paddleSub.current_billing_period?.ends_at
      ? new Date(paddleSub.current_billing_period.ends_at)
      : undefined;
    const trialEnd = paddleSub.next_billed_at && status === 'trialing'
      ? new Date(paddleSub.next_billed_at)
      : undefined;
    const scheduledCancel =
      paddleSub.scheduled_change?.action === 'cancel' && paddleSub.scheduled_change?.effective_at
        ? new Date(paddleSub.scheduled_change.effective_at)
        : undefined;
    const cancelDate = scheduledCancel
      ?? (status === 'cancelled'
        ? (paddleSub.canceled_at ? new Date(paddleSub.canceled_at) : new Date())
        : undefined);
    const existingSubscription = await Subscription.findOne({ paddleSubscriptionId: paddleSub.id })
      .select('status activationDate currentPeriodEnd planId nextPlanId billingCycle nextBillingCycle')
      .populate('planId', 'tier')
      .populate('nextPlanId', 'tier')
      .lean();
    const previousPlan = (existingSubscription as any)?.planId as { _id?: string; tier?: PlanTier } | undefined;
    const previousNextPlan = (existingSubscription as any)?.nextPlanId as { _id?: string; tier?: PlanTier } | undefined;
    const previousTier = previousPlan?.tier as PlanTier | undefined;
    const nextTier = plan.tier as PlanTier;
    const periodAdvanced = didBillingPeriodAdvance((existingSubscription as any)?.currentPeriodEnd ?? null, periodEnd ?? null);
    const hadPendingPlanChange =
      (!!previousNextPlan?._id && String(previousNextPlan._id) !== String(previousPlan?._id)) ||
      (!!(existingSubscription as any)?.nextBillingCycle && (existingSubscription as any).nextBillingCycle !== (existingSubscription as any).billingCycle);
    const isImmediateUpgrade = isTierUpgrade(previousTier, nextTier);
    const shouldStagePlanChange =
      !scheduledCancel &&
      !!previousPlan &&
      !periodAdvanced &&
      isTierDowngrade(previousTier, nextTier);
    const shouldPreserveCurrentPlanOnCancel =
      !!previousPlan &&
      !!scheduledCancel &&
      (hadPendingPlanChange || !isImmediateUpgrade);
    const activePlanTier: PlanTier = shouldStagePlanChange || shouldPreserveCurrentPlanOnCancel
      ? (previousTier ?? nextTier)
      : nextTier;
    const activeBillingCycle: BillingCycle = shouldStagePlanChange || shouldPreserveCurrentPlanOnCancel
      ? ((existingSubscription as any)?.billingCycle ?? billingCycle)
      : billingCycle;

    const setFields: Record<string, unknown> = {
      userId,
      grantSource: status === 'trialing' ? 'trial' : 'paid',
      status,
      activationDate: (existingSubscription as any)?.activationDate
        ?? (paddleSub.created_at ? new Date(paddleSub.created_at) : new Date()),
      paddleSubscriptionId: paddleSub.id,
      paddleCustomerId: paddleSub.customer_id,
      ...(periodEnd ? { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd } : {}),
      ...(trialEnd ? { trialEndDate: trialEnd } : {}),
      ...(cancelDate ? { cancelDate } : {}),
      ...(!scheduledCancel ? { autoRenewReminderStages: [] } : {}),
      ...(!trialEnd ? { trialReminderStages: [] } : {}),
    };
    const unsetFields: Record<string, string> = {
      ...(!cancelDate ? { cancelDate: '' } : {}),
      ...(!trialEnd ? { trialEndDate: '' } : {}),
    };

    if (shouldStagePlanChange) {
      setFields.planId = previousPlan?._id ?? plan._id;
      setFields.billingCycle = (existingSubscription as any)?.billingCycle ?? billingCycle;
      setFields.nextPlanId = plan._id;
      setFields.nextBillingCycle = billingCycle;
    } else if (shouldPreserveCurrentPlanOnCancel) {
      setFields.planId = previousPlan?._id ?? plan._id;
      setFields.billingCycle = (existingSubscription as any)?.billingCycle ?? billingCycle;
      unsetFields.nextPlanId = '';
      unsetFields.nextBillingCycle = '';
    } else {
      setFields.planId = plan._id;
      setFields.billingCycle = billingCycle;
      unsetFields.nextPlanId = '';
      unsetFields.nextBillingCycle = '';
    }

    if (scheduledCancel) {
      unsetFields.nextPlanId = '';
      unsetFields.nextBillingCycle = '';
    }

    const updateDoc: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: paddleSub.id },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await User.findByIdAndUpdate(userId, {
      subscriptionId:   subscription._id,
      paddleCustomerId: paddleSub.customer_id,
      subscriptionStatus: status,
    });

    if (shouldTopUpBalanceOnSubscriptionUpdate({
      previousStatus: (existingSubscription as any)?.status ?? null,
      nextStatus: status as SubscriptionStatus,
      previousPeriodEnd: (existingSubscription as any)?.currentPeriodEnd ?? null,
      nextPeriodEnd: periodEnd ?? null,
      previousTier: (existingSubscription as any)?.planId?.tier as PlanTier | undefined,
      nextTier: plan.tier as PlanTier,
    })) {
      const def = getPlanDefinition(plan.tier as PlanTier);
      await Promise.all([
        topUpCredits(userId, def.imageUploadLimit),
        topUpAlerts(userId, def.alertLimit),
      ]);
    }

    console.log(`[Paddle Sync] userId=${userId} paddleSubId=${paddleSub.id} status=${status} plan=${plan.tier}`);

    res.json({
      success: true,
      synced: true,
      status,
      plan: activePlanTier,
      billingCycle: activeBillingCycle,
      paddleSubscriptionId: paddleSub.id,
    });
  } catch (err: any) {
    const paddleError = err?.response?.data;
    console.error('[Paddle Sync Error]', JSON.stringify(paddleError ?? err?.message, null, 2));
    const msg = paddleError?.error?.detail || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg });
  }
};

