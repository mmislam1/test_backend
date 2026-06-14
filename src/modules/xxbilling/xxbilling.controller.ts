import { Request, Response } from 'express';
import { Search } from '../../models/searches';
import { User } from '../../models/users';
import { XXPayment } from '../../models/xxpayment';
import { XXSubscription, type XXSubscriptionStatus } from '../../models/xxsubscription';
import type { XXBillingCycle, XXPlanTier } from '../../models/xxplan';
import {
  PLAN_DEFINITIONS,
  getXXPlanDefinition,
  getXXPriceId,
} from './xxbilling.constants';
import {
  xxEvaluateSubscriptionAccess,
  xxGetEffectiveSubscriptionForUser,
  xxIsPaddlePriceId,
  xxNotifyUser,
  xxPickEffectiveSubscription,
} from './xxbilling.service';
import {
  xxGetOrCreatePaddleCustomer,
  xxIsPaddleNotFoundError,
  xxPatchPaddleSubscriptionPlan,
  xxPaddleRequest,
  xxSyncSubscriptionFromPaddlePayload,
} from './xxpaddle.service';
import { xxLogBilling } from './xxbilling.logger';

const formatBillingDate = (value?: Date | string | null): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const monthUsage = async (userId: string) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return Search.countDocuments({ userId, date: { $gte: monthStart } });
};

const toPublicPlan = (tier: XXPlanTier, permanentPdfAccess = false) => {
  const plan = getXXPlanDefinition(tier);
  return {
    ...plan,
    pdfEnabled: plan.pdfEnabled || permanentPdfAccess,
  };
};

const subscriptionPayload = (
  sub: any,
  permanentPdfAccess = false,
  userPaddleStatus?: string | null,
  deferredSub?: any | null,
) => {
  if (!sub) return null;

  const access = xxEvaluateSubscriptionAccess(sub, userPaddleStatus);
  const activePlan = toPublicPlan(sub.planTier, permanentPdfAccess);

  // --- Trial end date ---
  // Local trials may have status 'trialing' OR 'active' (referral grants).
  // xxEvaluateSubscriptionAccess only sets trialEndsAt when effectiveStatus === 'trialing',
  // so we also check trialEndDate and currentPeriodEnd for any trial/referral grant.
  const isTrial =
    access.isTrialing ||
    (access.grantSource === 'trial' && access.hasAccess) ||
    (access.grantSource === 'referral' && access.hasAccess && !sub.paddleSubscriptionId);

  const trialEndsAt: Date | null =
    access.trialEndsAt ??                                                  // Paddle-managed trial
    (isTrial
      ? (sub.trialEndDate
          ? new Date(sub.trialEndDate)
          : sub.currentPeriodEnd
            ? new Date(sub.currentPeriodEnd)
            : null)
      : null);

  const trialDaysLeft = isTrial && trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;

  // --- Renewal / billing dates ---
  // For Paddle-managed subs: nextBillingDate is the renewal date.
  // For trials (no Paddle): there is no renewal — access ends at trialEndsAt.
  // cancelDate means auto-renew is off; access ends at cancelDate.
  const autoRenewEnabled = !!sub.autoRenewEnabled && !sub.cancelDate;

  // accessEndsAt: single unambiguous "when does your access stop?" field.
  //   - auto-renew off → cancelDate
  //   - trial (no paddle) → trialEndsAt
  //   - paid with auto-renew → null (renews indefinitely unless cancelled)
  const accessEndsAt: Date | null =
    sub.cancelDate
      ? new Date(sub.cancelDate)
      : isTrial && !sub.paddleSubscriptionId
        ? trialEndsAt
        : null;

  // renewsAt: next billing / renewal date for paid Paddle subs with auto-renew on.
  const renewsAt: Date | null =
    autoRenewEnabled && sub.paddleSubscriptionId
      ? (sub.nextBillingDate ? new Date(sub.nextBillingDate) : sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null)
      : null;

  // --- Scheduled plan change ---
  const nextPlanTier = autoRenewEnabled ? (sub.nextPlanTier ?? sub.planTier) : null;
  const nextPlan = nextPlanTier ? toPublicPlan(nextPlanTier, permanentPdfAccess) : null;
  const nextBillingCycle = autoRenewEnabled ? (sub.nextBillingCycle ?? sub.billingCycle ?? null) : null;
  const hasScheduledPlanChange =
    autoRenewEnabled &&
    (!!sub.nextPlanTier || !!sub.nextBillingCycle) &&
    ((sub.nextPlanTier ?? sub.planTier) !== sub.planTier ||
      (sub.nextBillingCycle ?? sub.billingCycle) !== sub.billingCycle);

  // --- Deferred downgrade (purchased lower-tier plan while trialling) ---
  const pendingDowngrade = deferredSub
    ? {
        planTier: deferredSub.planTier,
        billingCycle: deferredSub.billingCycle,
        activatesAt: deferredSub.deferredActivationDate
          ? new Date(deferredSub.deferredActivationDate)
          : trialEndsAt,
        currentPeriodEnd: deferredSub.currentPeriodEnd
          ? new Date(deferredSub.currentPeriodEnd)
          : null,
        plan: toPublicPlan(deferredSub.planTier, permanentPdfAccess),
      }
    : null;

  return {
    id: sub._id,
    status: access.effectiveStatus,
    paddleStatus: userPaddleStatus ?? null,
    hasAccess: access.hasAccess,
    billingCycle: sub.billingCycle,
    grantSource: access.grantSource,

    // Trial fields
    isTrial,
    isTrialing: access.isTrialing || (isTrial && !sub.paddleSubscriptionId),
    trialEndsAt,
    trialDaysLeft,

    isPastDue: access.effectiveStatus === 'past_due',
    activationDate: sub.activationDate,
    currentPeriodEnd: sub.currentPeriodEnd,
    nextBillingDate: sub.nextBillingDate,
    cancelDate: sub.cancelDate,
    autoRenewEnabled,

    // Clear, unambiguous date fields for the UI
    accessEndsAt,
    renewsAt,

    // Scheduled renewal plan change
    nextPlan,
    nextBillingCycle,
    hasScheduledPlanChange,
    planChangeEffectiveAt: hasScheduledPlanChange
      ? (sub.nextBillingDate ?? sub.currentPeriodEnd ?? null)
      : null,

    // Deferred downgrade purchased during trial
    pendingDowngrade,

    paddleManaged: !!sub.paddleSubscriptionId,
    plan: activePlan,
  };
};

export const getPlans = async (_req: Request, res: Response) => {
  res.json({ success: true, plans: PLAN_DEFINITIONS });
};

export const getSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const [subscriptions, userDoc, imagesUsedThisMonth] = await Promise.all([
      XXSubscription.find({ userId }).sort({ activationDate: -1, createdAt: -1 }).lean(),
      User.findById(userId).select('permanentPdfAccess credits subscriptionStatus paddleSubscriptionId alertsRemaining').lean(),
      monthUsage(userId),
    ]);

    const sub = xxPickEffectiveSubscription(subscriptions as any[], (userDoc as any)?.paddleSubscriptionId ?? null);
    const access = xxEvaluateSubscriptionAccess(sub as any, (userDoc as any)?.subscriptionStatus ?? null);
    const tier: XXPlanTier = access.hasAccess ? ((sub as any)?.planTier ?? 'starter') : 'starter';
    const plan = toPublicPlan(tier, !!(userDoc as any)?.permanentPdfAccess);

    // If the effective subscription is a local trial, look for a deferred paid downgrade
    // that is waiting to activate after the trial ends. Surfaced as `pendingDowngrade` in
    // the payload so the UI can inform the user what plan kicks in after their trial.
    const isLocalTrial =
      !!sub &&
      !(sub as any).paddleSubscriptionId &&
      ((sub as any).grantSource === 'trial' || (sub as any).grantSource === 'referral') &&
      access.hasAccess;

    const deferredSub = isLocalTrial
      ? (subscriptions as any[]).find(
          (s) =>
            s.status === 'pending' &&
            s.paddleSubscriptionId &&
            s.deferredActivationDate,
        ) ?? null
      : null;

    res.json({
      success: true,
      subscription: subscriptionPayload(
        sub,
        !!(userDoc as any)?.permanentPdfAccess,
        (userDoc as any)?.subscriptionStatus ?? null,
        deferredSub,
      ),
      plan,
      credits: (userDoc as any)?.credits ?? 0,
      alertsRemaining: (userDoc as any)?.alertsRemaining ?? 0,
      usage: {
        imagesUsedThisMonth,
        imageUploadLimit: plan.imageUploadLimit,
        alertLimit: plan.alertLimit,
        pdfEnabled: plan.pdfEnabled,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

export const getPlanLimits = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const [sub, userDoc] = await Promise.all([
      xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'past_due']),
      User.findById(userId).select('permanentPdfAccess subscriptionStatus').lean(),
    ]);
    const access = xxEvaluateSubscriptionAccess(sub as any, (userDoc as any)?.subscriptionStatus ?? null);
    const tier: XXPlanTier = access.hasAccess ? ((sub as any)?.planTier ?? 'starter') : 'starter';
    const plan = toPublicPlan(tier, !!(userDoc as any)?.permanentPdfAccess);

    res.json({
      success: true,
      tier,
      alertLimit: plan.alertLimit,
      imageUploadLimit: plan.imageUploadLimit,
      pdfEnabled: plan.pdfEnabled,
      permanentPdfAccess: !!(userDoc as any)?.permanentPdfAccess,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

export const createPaddleCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const tier = String(req.body?.tier ?? '').toLowerCase() as XXPlanTier;
    const billingCycle = (req.body?.billingCycle === 'annual' ? 'annual' : 'monthly') as XXBillingCycle;
    let priceId = String(req.body?.priceId ?? '').trim();

    if (!priceId) {
      if (!['starter', 'pro', 'premium'].includes(tier)) {
        return res.status(400).json({ success: false, message: 'tier or priceId is required.' });
      }
      priceId = getXXPriceId(tier, billingCycle) ?? '';
    }

    if (!priceId) {
      return res.status(404).json({
        success: false,
        message: `No Paddle price ID configured for plan "${tier}" (${billingCycle}).`,
      });
    }

    if (!xxIsPaddlePriceId(priceId)) {
      return res.status(400).json({
        success: false,
        message: `Invalid Paddle price ID "${priceId}". Expected a Price ID like pri_xxxxxxxxxxxxxxxxxxxxxxxxxx.`,
      });
    }

    const user = await User.findById(userId).select('email name').lean();
    const paddleCustomerId = (user as any)?.email
      ? await xxGetOrCreatePaddleCustomer(userId, (user as any).email, (user as any).name)
      : undefined;

    const transaction = await xxPaddleRequest('post', '/transactions', {
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { userId, xxBilling: true, tier, billingCycle },
      ...(paddleCustomerId ? { customer_id: paddleCustomerId } : {}),
    });

    const transactionId = transaction?.data?.id;
    const checkoutUrl = transaction?.data?.checkout?.url ?? null;
    if (!transactionId) {
      return res.status(500).json({ success: false, message: 'Paddle did not return a transaction ID.' });
    }

    await xxLogBilling({
      userId,
      event: 'checkout_created',
      source: 'api',
      message: `Created checkout for ${tier || priceId} (${billingCycle}).`,
      paddleTransactionId: transactionId,
      metadata: { tier, billingCycle, priceId },
    });

    res.json({ success: true, transactionId, checkoutUrl });
  } catch (err: any) {
    const paddleError = err?.response?.data;
    const msg = paddleError?.error?.detail || paddleError?.error?.code || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg, paddleError: paddleError?.error ?? null });
  }
};

export const updateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const tier = String(req.body?.tier ?? '').toLowerCase() as XXPlanTier;
    const billingCycle = (req.body?.billingCycle === 'annual' ? 'annual' : 'monthly') as XXBillingCycle;

    if (!['starter', 'pro', 'premium'].includes(tier)) {
      return res.status(400).json({ success: false, message: 'Invalid plan tier.' });
    }

    const sub = await xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'past_due']);
    if (!sub) return res.status(404).json({ success: false, message: 'No active subscription found.' });
    if (sub.cancelDate || !sub.autoRenewEnabled) {
      return res.status(409).json({
        success: false,
        message: 'Auto-renew is off. Resume auto-renew before changing the renewal plan.',
        code: 'AUTO_RENEW_DISABLED',
      });
    }

    const currentRenewalTier = sub.nextPlanTier ?? sub.planTier;
    const currentRenewalCycle = sub.nextBillingCycle ?? sub.billingCycle;
    const targetPlan = getXXPlanDefinition(tier);
    const effectiveAt = sub.nextBillingDate ?? sub.currentPeriodEnd ?? null;

    if (currentRenewalTier === tier && currentRenewalCycle === billingCycle) {
      return res.json({
        success: true,
        syncedLocally: false,
        changeTiming: (sub.nextPlanTier || sub.nextBillingCycle) ? 'next_billing_period' : 'none',
        effectiveAt: (sub.nextPlanTier || sub.nextBillingCycle) ? effectiveAt : null,
        message: (sub.nextPlanTier || sub.nextBillingCycle)
          ? `Your renewal is already set to ${targetPlan.name} (${billingCycle}).`
          : `You are already on ${targetPlan.name} (${billingCycle}).`,
      });
    }

    const isResetToCurrent = sub.planTier === tier && sub.billingCycle === billingCycle;
    const update = isResetToCurrent
      ? { $unset: { nextPlanTier: '', nextBillingCycle: '' } }
      : { $set: { nextPlanTier: tier, nextBillingCycle: billingCycle } };

    await XXSubscription.findByIdAndUpdate((sub as any)._id, update);
    await Promise.all([
      xxNotifyUser(userId, isResetToCurrent
        ? `Renewal plan reset. ${getXXPlanDefinition(sub.planTier).name} (${sub.billingCycle}) will continue at the next billing date.`
        : `Your plan will change to ${targetPlan.name} (${billingCycle}) at the next billing date.`,
        { tier, billingCycle, effectiveAt }),
      xxLogBilling({
        userId,
        event: 'plan_change_scheduled',
        source: 'api',
        message: isResetToCurrent
          ? `Cleared scheduled plan change.`
          : `Scheduled ${tier} (${billingCycle}) for next billing period.`,
        paddleSubscriptionId: sub.paddleSubscriptionId,
        metadata: { currentTier: sub.planTier, currentCycle: sub.billingCycle, tier, billingCycle, effectiveAt },
      }),
    ]);

    const effectiveAtText = formatBillingDate(effectiveAt);
    res.json({
      success: true,
      syncedLocally: false,
      changeTiming: 'next_billing_period',
      effectiveAt,
      message: isResetToCurrent
        ? `Renewal plan reset. ${getXXPlanDefinition(sub.planTier).name} (${sub.billingCycle}) will continue${effectiveAtText ? ` on ${effectiveAtText}` : ' at the next billing date'}.`
        : `Change to ${targetPlan.name} (${billingCycle}) scheduled${effectiveAtText ? ` for ${effectiveAtText}` : ' for the next billing date'}. Your current plan, access, and remaining credits stay unchanged until then.`,
      paddleSubscriptionId: sub.paddleSubscriptionId,
    });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(xxIsPaddleNotFoundError(err) ? 409 : 500).json({ success: false, message: msg });
  }
};

export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const sub = await xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'past_due']);
    if (!sub) return res.status(404).json({ success: false, message: 'No active subscription found.' });

    let effectiveAt = sub.nextBillingDate ?? sub.currentPeriodEnd ?? new Date();
    if (sub.paddleSubscriptionId) {
      const cancelResponse = await xxPaddleRequest('post', `/subscriptions/${sub.paddleSubscriptionId}/cancel`, {
        effective_from: 'next_billing_period',
      });
      const paddleEffectiveAt = cancelResponse?.data?.scheduled_change?.effective_at;
      if (paddleEffectiveAt) effectiveAt = new Date(paddleEffectiveAt);
    }

    await XXSubscription.findByIdAndUpdate((sub as any)._id, {
      $set: { cancelDate: effectiveAt, autoRenewEnabled: false, autoRenewReminderStages: [] },
      $unset: { nextPlanTier: '', nextBillingCycle: '' },
    });

    await Promise.all([
      xxNotifyUser(userId, 'Auto-renew is off. Any scheduled plan change was canceled.', { effectiveAt }),
      xxLogBilling({
        userId,
        event: 'auto_renew_disabled',
        source: 'api',
        message: 'Auto-renew turned off and scheduled subscription change cleared.',
        paddleSubscriptionId: sub.paddleSubscriptionId,
        metadata: { effectiveAt },
      }),
    ]);

    const effectiveAtText = formatBillingDate(effectiveAt);
    res.json({
      success: true,
      effectiveAt,
      message: `Auto-renew turned off. Your subscription stays active${effectiveAtText ? ` until ${effectiveAtText}` : ' until the end of the current billing period'}. No next plan is scheduled.`,
    });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(xxIsPaddleNotFoundError(err) ? 409 : 500).json({ success: false, message: msg });
  }
};

export const pauseSubscription = async (_req: Request, res: Response) => {
  res.status(400).json({
    success: false,
    message: 'Pausing is not supported by the updated billing policy. Turn auto-renew off instead.',
  });
};

export const resumeSubscription = async (req: Request, res: Response) => resumeAutoRenew(req, res);

export const resumeAutoRenew = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const sub = await xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'past_due']);
    if (!sub) return res.status(404).json({ success: false, message: 'No renewable subscription found.' });
    if (!sub.paddleSubscriptionId) {
      return res.status(400).json({ success: false, message: 'Subscription is not managed by Paddle.' });
    }

    await xxPatchPaddleSubscriptionPlan(sub.paddleSubscriptionId, sub.planTier, sub.billingCycle);
    await xxPaddleRequest('patch', `/subscriptions/${sub.paddleSubscriptionId}`, { scheduled_change: null });
    await XXSubscription.findByIdAndUpdate((sub as any)._id, {
      $set: { autoRenewEnabled: true, autoRenewReminderStages: [] },
      $unset: { cancelDate: '', nextPlanTier: '', nextBillingCycle: '' },
    });

    await Promise.all([
      xxNotifyUser(userId, 'Auto-renew resumed. Your subscription will renew at the next billing date.'),
      xxLogBilling({
        userId,
        event: 'auto_renew_resumed',
        source: 'api',
        message: 'Auto-renew resumed and scheduled changes cleared.',
        paddleSubscriptionId: sub.paddleSubscriptionId,
      }),
    ]);

    res.json({ success: true, message: 'Auto-renew resumed. Your subscription will renew at the next billing date.' });
  } catch (err: any) {
    const msg = err?.response?.data?.error?.detail || err?.message || 'Server error';
    res.status(xxIsPaddleNotFoundError(err) ? 409 : 500).json({ success: false, message: msg });
  }
};

const portalSession = async (userId: string, focused: boolean) => {
  const [sub, userDoc] = await Promise.all([
    xxGetEffectiveSubscriptionForUser(userId, ['active', 'trialing', 'paused', 'past_due', 'cancelled' as XXSubscriptionStatus]),
    User.findById(userId).select('paddleCustomerId').lean(),
  ]);
  const paddleCustomerId = sub?.paddleCustomerId || (userDoc as any)?.paddleCustomerId;
  if (!paddleCustomerId) {
    const error: any = new Error('No Paddle customer record found. Please subscribe first.');
    error.statusCode = 404;
    throw error;
  }
  const data = await xxPaddleRequest(
    'post',
    `/customers/${paddleCustomerId}/portal-sessions`,
    focused && sub?.paddleSubscriptionId ? { subscription_ids: [sub.paddleSubscriptionId] } : {},
  );
  return focused
    ? (data?.data?.urls?.subscriptions?.[0]?.update_subscription_payment_method ?? data?.data?.urls?.general?.overview)
    : data?.data?.urls?.general?.overview;
};

export const getUpdatePaymentUrl = async (req: Request, res: Response) => {
  try {
    const portalUrl = await portalSession(req.user?.id as string, true);
    if (!portalUrl) return res.status(500).json({ success: false, message: 'Could not retrieve portal URL from Paddle.' });
    res.json({ success: true, portalUrl, updateUrl: portalUrl });
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ success: false, message: err?.message || 'Server error' });
  }
};

export const getBillingPortalUrl = async (req: Request, res: Response) => {
  try {
    const portalUrl = await portalSession(req.user?.id as string, false);
    if (!portalUrl) return res.status(500).json({ success: false, message: 'Could not retrieve billing portal URL from Paddle.' });
    res.json({ success: true, portalUrl });
  } catch (err: any) {
    res.status(err?.statusCode || 500).json({ success: false, message: err?.message || 'Server error' });
  }
};

export const getBillingHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      XXPayment.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('amount currency status paddleTransactionId paddleSubscriptionId createdAt')
        .lean(),
      XXPayment.countDocuments({ userId }),
    ]);
    res.json({
      success: true,
      items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'Server error' });
  }
};

export const syncSubscriptionFromPaddle = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;
    const transactionId = String(req.body?.transactionId ?? '').trim();
    let paddleSub: any;

    if (transactionId) {
      const tx = (await xxPaddleRequest('get', `/transactions/${transactionId}`))?.data;
      if (tx?.customer_id) await User.findByIdAndUpdate(userId, { paddleCustomerId: tx.customer_id });
      if (tx?.subscription_id) {
        paddleSub = (await xxPaddleRequest('get', `/subscriptions/${tx.subscription_id}`))?.data;
      }
    }

    if (!paddleSub) {
      const user = await User.findById(userId).select('paddleCustomerId email').lean();
      let customerId = (user as any)?.paddleCustomerId;
      if (!customerId && (user as any)?.email) {
        const customers = (await xxPaddleRequest('get', `/customers?email=${encodeURIComponent((user as any).email)}&per_page=5`))?.data ?? [];
        customerId = customers[0]?.id;
        if (customerId) await User.findByIdAndUpdate(userId, { paddleCustomerId: customerId });
      }
      if (!customerId) {
        return res.status(404).json({ success: false, message: 'No Paddle customer found for this account. Complete a checkout first.' });
      }
      const list = (await xxPaddleRequest('get', `/subscriptions?customer_id=${customerId}&per_page=10`))?.data ?? [];
      paddleSub = list[0];
    }

    if (!paddleSub) return res.json({ success: true, synced: false, message: 'No subscriptions found in Paddle for this customer.' });

    const sub = await xxSyncSubscriptionFromPaddlePayload(paddleSub, userId);
    if (!sub) return res.status(422).json({ success: false, message: 'Could not sync Paddle subscription.' });

    res.json({
      success: true,
      synced: true,
      status: sub.status,
      plan: sub.planTier,
      billingCycle: sub.billingCycle,
      paddleSubscriptionId: sub.paddleSubscriptionId,
    });
  } catch (err: any) {
    const paddleError = err?.response?.data;
    const msg = paddleError?.error?.detail || err?.message || 'Server error';
    res.status(500).json({ success: false, message: msg });
  }
};