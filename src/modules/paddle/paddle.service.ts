import { User } from '../../models/users';
import { Plan, type PlanTier } from '../../models/plan';
import { Subscription } from '../../models/subscriptions';
import type { BillingCycle, SubscriptionStatus } from '../../models/subscriptions';
import { Payment } from '../../models/payment';
import { createUserAlert, topUpCredits, topUpAlerts } from '../../common/helpers/alert.helper';
import {
  didBillingPeriodAdvance,
  isTierDowngrade,
  isTierUpgrade,
  shouldTopUpBalanceOnSubscriptionUpdate,
} from '../billing/subscription-change.helpers';

const mapToUserSubscriptionStatus = (
  status: SubscriptionStatus,
): 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused' | undefined => {
  if (status === 'cancelled') return 'canceled';
  if (status === 'active' || status === 'trialing' || status === 'past_due' || status === 'paused') {
    return status;
  }
  return undefined;
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

export class PaddleService {

  /**
   * Resolve userId from custom_data first; fall back to fetching it from the
   * existing Subscription document keyed on Paddle's subscription ID.
   * This covers renewal transactions where custom_data is empty.
   */
  private static async resolveUserId(
    customData: Record<string, any>,
    paddleSubscriptionId?: string,
  ): Promise<string | undefined> {
    if (customData.userId) return customData.userId as string;
    if (paddleSubscriptionId) {
      const sub = await Subscription.findOne({ paddleSubscriptionId }).select('userId').lean();
      return sub?.userId?.toString();
    }
    return undefined;
  }

  static async handleSubscriptionTrialing(data: any) {
    const customData = data.custom_data || {};
    const userId = await this.resolveUserId(customData, data.id);
    if (!userId) throw new Error(`[Paddle] subscription.trialing: could not resolve userId for sub ${data.id}`);

    const paddlePriceId = data.items[0].price.id;

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
        { paddleTrialPriceId:   paddlePriceId },
      ],
    });
    if (!plan) throw new Error(`Plan not found for price ID: ${paddlePriceId}`);

    const billingCycle: BillingCycle =
      data.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';

    const trialEnd = data.next_billed_at ? new Date(data.next_billed_at) : undefined;

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: {
          userId,
          planId: plan._id,
          billingCycle,
          grantSource: 'trial',
          status: 'trialing',
          activationDate: new Date(),
          trialEndDate: trialEnd,
          currentPeriodEnd: trialEnd,
          nextBillingDate: trialEnd,
          paddleSubscriptionId: data.id,
          paddleCustomerId: data.customer_id,
          autoRenewReminderStages: [],
          trialReminderStages: [],
        },
        $unset: { nextPlanId: '', nextBillingCycle: '', cancelDate: '' },
      },
      { upsert: true, new: true },
    );

    await Subscription.updateMany(
      {
        userId,
        _id: { $ne: subscription._id },
        status: { $in: ['active', 'trialing'] },
      },
      {
        status: 'cancelled',
        cancelDate: new Date(),
      },
    );

    await User.findByIdAndUpdate(userId, {
      subscriptionId:   subscription._id,
      paddleCustomerId: data.customer_id,
      subscriptionStatus: 'trialing',
    });

    const daysLeft = trialEnd
      ? Math.ceil((trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      : 0;
    await createUserAlert(userId, {
      title: `Your ${plan.name} free trial has started! You have ${daysLeft} day(s) remaining.`,
      type: 'billing',
    });
  }

  /**
   * Handles subscription.created — fires as soon as Paddle creates the subscription
   * (before activated/trialing). Upserts the initial subscription record so access
   * can be granted immediately rather than waiting for the follow-up event.
   */
  static async handleSubscriptionCreated(data: any) {
    const customData = data.custom_data || {};
    const userId = await this.resolveUserId(customData, data.id);
    if (!userId) {
      // custom_data may be absent for imported/API-created subscriptions — warn and let
      // the subsequent activated/trialing event handle it.
      console.warn(`[Paddle] subscription.created: could not resolve userId for sub ${data.id}`);
      return;
    }

    const paddlePriceId = data.items?.[0]?.price?.id;
    if (!paddlePriceId) {
      console.warn(`[Paddle] subscription.created: no price ID found for sub ${data.id}`);
      return;
    }

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
        { paddleTrialPriceId:   paddlePriceId },
      ],
    });
    if (!plan) {
      console.warn(`[Paddle] subscription.created: plan not found for price ID: ${paddlePriceId}`);
      return;
    }

    const billingCycle: BillingCycle =
      data.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';

    const PADDLE_STATUS_MAP: Record<string, SubscriptionStatus> = {
      active:   'active',
      trialing: 'trialing',
      paused:   'paused',
      past_due: 'past_due',
      canceled: 'cancelled',
    };
    const status: SubscriptionStatus = PADDLE_STATUS_MAP[data.status] ?? 'pending';
    const isTrialing = status === 'trialing';

    const periodEnd = data.current_billing_period?.ends_at
      ? new Date(data.current_billing_period.ends_at)
      : undefined;
    const trialEnd = isTrialing && data.next_billed_at
      ? new Date(data.next_billed_at)
      : undefined;

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: {
          userId,
          planId: plan._id,
          billingCycle,
          grantSource: isTrialing ? 'trial' : 'paid',
          status,
          activationDate: new Date(),
          paddleSubscriptionId: data.id,
          paddleCustomerId: data.customer_id,
          ...(periodEnd && { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd }),
          ...(trialEnd && { trialEndDate: trialEnd }),
        },
        $unset: { nextPlanId: '', nextBillingCycle: '', cancelDate: '' },
      },
      { upsert: true, new: true },
    );

    const userStatusFromCreated = mapToUserSubscriptionStatus(status);
    await User.findByIdAndUpdate(userId, {
      subscriptionId:   subscription._id,
      paddleCustomerId: data.customer_id,
      ...(userStatusFromCreated ? { subscriptionStatus: userStatusFromCreated } : {}),
    });
  }

  // ==========================================
  // TRANSACTION EVENTS (Payments & Refunds)
  // ==========================================

  static async handleTransactionCompleted(data: any) {
    const customData = data.custom_data || {};

    // Idempotency: skip if we already recorded this transaction
    const existing = await Payment.findOne({ paddleTransactionId: data.id });
    if (existing) {
      console.log(`[Paddle] Skipping duplicate transaction.completed: ${data.id}`);
      return existing;
    }

    // Resolve userId — may be absent on renewal transactions
    const userId = await this.resolveUserId(customData, data.subscription_id);
    if (!userId) {
      console.warn(`[Paddle] transaction.completed: could not resolve userId for tx ${data.id}`);
      return;
    }

    const payment = await Payment.create({
      userId,
      amount: parseInt(data.details.totals.total, 10) / 100,
      currency: data.currency_code,
      status: 'completed',
      paddleTransactionId: data.id,
      paddleSubscriptionId: data.subscription_id,
    });

    await createUserAlert(userId, {
      title: `Payment of ${payment.currency} ${payment.amount} was successful.`,
      type: 'billing',
    });
    return payment;
  }

  static async handleTransactionFailed(data: any) {
    const customData = data.custom_data || {};

    // Idempotency: upsert so retried webhooks don't create duplicate records
    const userId = await this.resolveUserId(customData, data.subscription_id);
    if (!userId) {
      console.warn(`[Paddle] transaction.payment_failed: could not resolve userId for tx ${data.id}`);
      return;
    }

    await Payment.findOneAndUpdate(
      { paddleTransactionId: data.id },
      {
        $setOnInsert: {
          userId,
          amount: parseInt(data.details.totals.total, 10) / 100,
          currency: data.currency_code,
          status: 'failed',
          paddleTransactionId: data.id,
          paddleSubscriptionId: data.subscription_id,
        },
      },
      { upsert: true },
    );

    await createUserAlert(userId, {
      title: 'A recent payment attempt failed. Please update your billing information.',
      type: 'billing',
    });
  }

  /**
   * Handles adjustment.created / adjustment.updated (Paddle Billing v2 refunds).
   * An adjustment links back to the original transaction via `transaction_id`.
   */
  static async handleAdjustmentCreated(data: any) {
    if (data.action !== 'refund' && data.action !== 'credit') return;

    const transactionId = data.transaction_id;
    const payment = await Payment.findOneAndUpdate(
      { paddleTransactionId: transactionId },
      { status: 'refunded' },
      { new: true },
    );

    if (payment) {
      await createUserAlert(
        payment.userId.toString(),
        {
          title: `A refund has been processed for transaction ${transactionId}.`,
          type: 'billing',
        },
      );
    } else {
      console.warn(`[Paddle] adjustment: no payment found for transaction ${transactionId}`);
    }
  }

  // ==========================================
  // SUBSCRIPTION EVENTS (Lifecycle)
  // ==========================================

  static async handleSubscriptionActivated(data: any) {
    const customData = data.custom_data || {};
    const userId = await this.resolveUserId(customData, data.id);
    if (!userId) throw new Error(`[Paddle] subscription.activated: could not resolve userId for sub ${data.id}`);

    const paddlePriceId = data.items[0].price.id;
    console.log(`[Paddle] subscription.activated | subId=${data.id} | customerId=${data.customer_id} | priceId=${paddlePriceId} | userId=${userId}`);

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
      ],
    });
    if (!plan) throw new Error(`Plan not found for price ID: ${paddlePriceId}`);
    console.log(`[Paddle] subscription.activated | plan=${plan.tier} | billingCycle=${data.billing_cycle?.interval}`);

    const billingCycle: BillingCycle =
      data.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';

    const periodEnd = new Date(data.current_billing_period.ends_at);

    // FIX: must separate $set fields from $unset operator.
    // Mixing plain fields with $ operators in one document causes MongoDB to reject the update silently.
    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: {
          userId,
          planId: plan._id,
          billingCycle,
          grantSource: 'paid',
          status: 'active',
          activationDate: new Date(),
          currentPeriodEnd: periodEnd,
          nextBillingDate:  periodEnd,
          paddleSubscriptionId: data.id,
          paddleCustomerId: data.customer_id,
          autoRenewReminderStages: [],
          trialReminderStages: [],
        },
        $unset: { trialEndDate: '', nextPlanId: '', nextBillingCycle: '', cancelDate: '' },
      },
      { upsert: true, new: true },
    );
    console.log(`[Paddle] subscription.activated | DB upsert done | docId=${subscription._id} | status=${subscription.status}`);

    const userUpdate = await User.findByIdAndUpdate(userId, {
      subscriptionId:   subscription._id,
      paddleCustomerId: data.customer_id,
      subscriptionStatus: 'active',
    }, { new: true });
    console.log(`[Paddle] subscription.activated | user updated | email=${userUpdate?.email} | subscriptionStatus=${userUpdate?.subscriptionStatus}`);

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

    // Top up the user's monitoring credits and alert quota
    await Promise.all([
      topUpCredits(userId, plan.imageUploadLimit),
      topUpAlerts(userId, plan.alertLimit),
    ]);

    await createUserAlert(userId, {
      title: `Your ${plan.name} (${billingCycle}) subscription is now active!`,
      type: 'billing',
    });
    console.log(`[Paddle] subscription.activated | complete | userId=${userId} | plan=${plan.tier}`);
  }

  static async handleSubscriptionUpdated(data: any) {
    // userId must come from the existing subscription record — custom_data is absent on renewals
    const existingSub = await Subscription.findOne({ paddleSubscriptionId: data.id })
      .select('userId planId nextPlanId billingCycle nextBillingCycle currentPeriodEnd status')
      .populate('planId', 'tier name')
      .populate('nextPlanId', 'tier name')
      .lean();

    const paddlePriceId = data.items[0].price.id;
    console.log(`[Paddle] subscription.updated | subId=${data.id} | paddleStatus=${data.status} | priceId=${paddlePriceId} | existingUserId=${existingSub?.userId ?? 'NOT FOUND'}`);

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
      ],
    });
    if (!plan) throw new Error(`Plan not found for price ID: ${paddlePriceId}`);

    const billingCycle: BillingCycle =
      data.billing_cycle?.interval === 'year' ? 'annual' : 'monthly';

    const periodEnd = data.current_billing_period?.ends_at
      ? new Date(data.current_billing_period.ends_at)
      : undefined;

    // Detect an end-of-period cancellation scheduled by Paddle
    const scheduledCancel =
      data.scheduled_change?.action === 'cancel'
        ? new Date(data.scheduled_change.effective_at)
        : undefined;

    // Map Paddle subscription statuses to internal statuses rather than collapsing
    // everything non-active to 'pending' (which would corrupt trialing/paused/past_due state).
    const PADDLE_STATUS_MAP: Record<string, SubscriptionStatus> = {
      active:   'active',
      trialing: 'trialing',
      paused:   'paused',
      past_due: 'past_due',
      canceled: 'cancelled',
    };
    const newStatus: SubscriptionStatus = PADDLE_STATUS_MAP[data.status] ?? 'pending';
    const trialEnd = newStatus === 'trialing' && data.next_billed_at
      ? new Date(data.next_billed_at)
      : undefined;
    const previousPlan = existingSub?.planId as any;
    const previousNextPlan = existingSub?.nextPlanId as any;
    const previousTier = previousPlan?.tier as PlanTier | undefined;
    const nextTier = plan.tier as PlanTier;
    const periodAdvanced = didBillingPeriodAdvance(existingSub?.currentPeriodEnd ?? null, periodEnd ?? null);
    const hadPendingPlanChange =
      (!!previousNextPlan?._id && String(previousNextPlan._id) !== String(previousPlan?._id)) ||
      (!!existingSub?.nextBillingCycle && existingSub.nextBillingCycle !== existingSub.billingCycle);
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
    const planChanged = !!previousPlan && String(previousPlan._id) !== String(plan._id);
    const billingCycleChanged = !!existingSub?.billingCycle && existingSub.billingCycle !== billingCycle;

    console.log(`[Paddle] subscription.updated | decision=${JSON.stringify({
      subId: data.id,
      previousPlanTier: previousTier ?? null,
      incomingPlanTier: nextTier,
      previousBillingCycle: existingSub?.billingCycle ?? null,
      incomingBillingCycle: billingCycle,
      previousPeriodEnd: existingSub?.currentPeriodEnd ?? null,
      incomingPeriodEnd: periodEnd ?? null,
      scheduledCancel: scheduledCancel?.toISOString() ?? null,
      hadPendingPlanChange,
      isImmediateUpgrade,
      periodAdvanced,
      shouldStagePlanChange,
      shouldPreserveCurrentPlanOnCancel,
      planChanged,
      billingCycleChanged,
    })}`);

    // FIX: build $set and $unset as separate operators.
    // Mixing plain fields with $ operators in one document causes MongoDB to reject the update silently.
    const setFields: Record<string, any> = {
      status: newStatus,
      grantSource: newStatus === 'trialing' ? 'trial' : 'paid',
      ...(periodEnd ? { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd } : {}),
      ...(scheduledCancel ? { cancelDate: scheduledCancel } : {}),
      ...(trialEnd ? { trialEndDate: trialEnd } : {}),
      ...(!scheduledCancel ? { autoRenewReminderStages: [] } : {}),
      ...(!trialEnd ? { trialReminderStages: [] } : {}),
    };

    const unsetFields: Record<string, string> = {
      ...(!scheduledCancel ? { cancelDate: '' } : {}),
      ...(!trialEnd ? { trialEndDate: '' } : {}),
    };

    if (shouldStagePlanChange) {
      setFields.nextPlanId = plan._id;
      setFields.nextBillingCycle = billingCycle;
    } else if (shouldPreserveCurrentPlanOnCancel) {
      setFields.planId = previousPlan._id;
      setFields.billingCycle = existingSub?.billingCycle ?? billingCycle;
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

    const updateDoc: Record<string, any> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      updateDoc,
      { new: true },
    );
    console.log(`[Paddle] subscription.updated | DB update done | docId=${subscription?._id ?? 'null'} | newStatus=${newStatus} | plan=${plan.tier}`);

    if (subscription) {
      if (existingSub?.userId) {
        const userStatus = mapToUserSubscriptionStatus(newStatus);
        await User.findByIdAndUpdate(existingSub.userId, {
          subscriptionId: subscription._id,
          ...(userStatus ? { subscriptionStatus: userStatus } : {}),
        });
      }

      if (newStatus === 'active') {
        await Subscription.updateMany(
          {
            userId: subscription.userId,
            _id: { $ne: subscription._id },
            status: { $in: ['active', 'trialing'] },
          },
          {
            status: 'cancelled',
            cancelDate: new Date(),
          },
        );
      }

      if (shouldTopUpBalanceOnSubscriptionUpdate({
        previousStatus: (existingSub?.status as SubscriptionStatus | undefined) ?? null,
        nextStatus: newStatus,
        previousPeriodEnd: existingSub?.currentPeriodEnd ?? null,
        nextPeriodEnd: periodEnd ?? null,
        previousTier,
        nextTier,
      })) {
        await Promise.all([
          topUpCredits(subscription.userId.toString(), plan.imageUploadLimit),
          topUpAlerts(subscription.userId.toString(), plan.alertLimit),
        ]);
      }

      const scheduledAtText = formatBillingDate(existingSub?.currentPeriodEnd ?? periodEnd ?? null);
      const renewedThroughText = formatBillingDate(periodEnd ?? null);
      let title = `Your subscription has been updated to ${plan.name} (${billingCycle}).`;

      if (scheduledCancel) {
        title = `Auto-renew is off. Your current plan stays active${scheduledAtText ? ` until ${scheduledAtText}` : ''}. No next plan is scheduled.${hadPendingPlanChange ? ' Any scheduled plan change was canceled.' : ''}`;
      } else if (shouldStagePlanChange) {
        title = `Your plan will change to ${plan.name} (${billingCycle})${scheduledAtText ? ` on ${scheduledAtText}` : ' at the next billing date'}. Your current ${previousPlan?.name ?? 'plan'} stays active until then.`;
      } else if (hadPendingPlanChange && !periodAdvanced && !planChanged && !billingCycleChanged) {
        title = `Your renewal plan has been reset. ${plan.name} (${billingCycle}) will continue at the next billing date.`;
      } else if (periodAdvanced && hadPendingPlanChange) {
        title = `Your scheduled plan change to ${plan.name} (${billingCycle}) is now active${renewedThroughText ? ` through ${renewedThroughText}` : ''}. Credits were added to your balance.`;
      } else if (periodAdvanced) {
        title = `Your ${plan.name} (${billingCycle}) subscription renewed${renewedThroughText ? ` through ${renewedThroughText}` : ''}. Credits were added to your balance.`;
      } else if (planChanged) {
        title = `Your subscription is now ${plan.name} (${billingCycle}). Credits were added to your balance.`;
      } else if (billingCycleChanged) {
        title = `Your billing cycle has been updated to ${billingCycle} on ${plan.name}.`;
      }

      await createUserAlert(
        subscription.userId.toString(),
        {
          title,
          type: 'billing',
        },
      );
    }
  }

  static async handleSubscriptionPastDue(data: any) {
    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      { status: 'past_due' },
      { new: true },
    );

    if (subscription) {
      await User.findByIdAndUpdate(subscription.userId, { subscriptionStatus: 'past_due' });
      await createUserAlert(
        subscription.userId.toString(),
        {
          title: 'Your subscription payment failed. We will retry soon. Please check your payment method.',
          type: 'billing',
        },
      );
    }
  }

  static async handleSubscriptionPaused(data: any) {
    const pausedAt = data.paused_at ? new Date(data.paused_at) : new Date();

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: { status: 'paused', currentPeriodEnd: pausedAt },
        $unset: { nextPlanId: '', nextBillingCycle: '' },
      },
      { new: true },
    );

    if (subscription) {
      await User.findByIdAndUpdate(subscription.userId, {
        subscriptionId: null,
        subscriptionStatus: 'paused',
      });
      await createUserAlert(
        subscription.userId.toString(),
        {
          title: 'Your subscription has been paused. Access has been suspended until you resume.',
          type: 'billing',
        },
      );
    }
  }

  static async handleSubscriptionResumed(data: any) {
    const paddlePriceId = data.items[0].price.id;

    const plan = await Plan.findOne({
      $or: [
        { paddleMonthlyPriceId: paddlePriceId },
        { paddleAnnualPriceId:  paddlePriceId },
      ],
    });

    const periodEnd = data.current_billing_period?.ends_at
      ? new Date(data.current_billing_period.ends_at)
      : undefined;

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: {
          status: 'active',
          ...(plan && { planId: plan._id }),
          autoRenewReminderStages: [],
          trialReminderStages: [],
          ...(periodEnd && { currentPeriodEnd: periodEnd, nextBillingDate: periodEnd }),
        },
        $unset: { cancelDate: '', nextPlanId: '', nextBillingCycle: '' },
      },
      { new: true },
    );

    if (subscription) {
      await User.findByIdAndUpdate(subscription.userId, {
        subscriptionId: subscription._id,
        subscriptionStatus: 'active',
      });
      await createUserAlert(
        subscription.userId.toString(),
        {
          title: `Your subscription has been resumed${plan ? ` (${plan.name})` : ''}.`,
          type: 'billing',
        },
      );
    }
  }

  static async handleSubscriptionCanceled(data: any) {
    // Use the effective cancellation date from Paddle, not the time we received the webhook
    const cancelDate =
      data.canceled_at
        ? new Date(data.canceled_at)
        : data.scheduled_change?.effective_at
          ? new Date(data.scheduled_change.effective_at)
          : new Date();

    const subscription = await Subscription.findOneAndUpdate(
      { paddleSubscriptionId: data.id },
      {
        $set: { status: 'cancelled', cancelDate },
        $unset: { nextPlanId: '', nextBillingCycle: '' },
      },
      { new: true },
    );

    if (subscription) {
      await User.findByIdAndUpdate(subscription.userId, {
        subscriptionId: null,
        subscriptionStatus: 'canceled',
      });
      await createUserAlert(
        subscription.userId.toString(),
        {
          title: 'Your subscription has been cancelled and access has been revoked.',
          type: 'billing',
        },
      );
    }
  }
}