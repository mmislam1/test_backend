import { Request, Response } from 'express';
import { User } from '../../models/users';
import { ReferralEvent } from '../../models/referral-event';
import { Subscription } from '../../models/subscriptions';
import { Plan } from '../../models/plan';
import { Reward } from '../../models/rewards';
import { getPlanDefinition } from '../billing/billing.constants';
import type { PlanTier } from '../../models/plan';
import { topUpCredits, topUpAlerts } from '../../common/helpers/alert.helper';

const DEFAULT_MILESTONE_COUNT = 5;
const PDF_REWARD_SLUG = 'pdf-generator';

const getReferralMilestoneCount = async (): Promise<number> => {
  const reward = await Reward.findOne({ slug: PDF_REWARD_SLUG, isActive: true })
    .select('referralsRequired')
    .lean();

  return reward?.referralsRequired ?? DEFAULT_MILESTONE_COUNT;
};

// ─── POST /api/v1/referral/generate ─────────────────────────────────────────
export const generateReferralCode = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const user = await User.findById(userId).select('referralCode permanentPdfAccess');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    return res.json({
      success: true,
      referralCode: user.referralCode,
      generatedAt: null,
      expiresAt: null,
      windowOpen: true,
      message: 'Your referral code is active and can be shared at any time.',
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET /api/v1/referral/status ────────────────────────────────────────────
export const getReferralStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id as string;

    const user = await User.findById(userId).select('referralCode referralCount permanentPdfAccess');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const [completedInWindow, milestoneTarget] = await Promise.all([
      ReferralEvent.countDocuments({
        referrerId: user._id,
        isCompleted: true,
      }),
      getReferralMilestoneCount(),
    ]);

    return res.json({
      success: true,
      referralCode:         user.referralCode,
      generatedAt:          null,
      expiresAt:            null,
      windowOpen:           true,
      completedInWindow,
      milestoneTarget,
      milestoneReached:     user.permanentPdfAccess,
      permanentPdfAccess:   user.permanentPdfAccess,
      totalReferrals:       user.referralCount,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Internal helper — called from auth.controller on email verification ───
/**
 * Mark the referral event for `newUserId` as completed exactly once and
 * check whether the referrer has now hit the 5-referral milestone.
 */
export const completeReferralEvent = async (newUserId: string): Promise<void> => {
  const now = new Date();

  // Idempotent transition: only the first completion updates the event.
  const event = await ReferralEvent.findOneAndUpdate({
    referredUserId: newUserId,
    isCompleted:    false,
  }, {
    $set: {
      isCompleted: true,
      completedAt: now,
    },
  }, {
    new: true,
  });

  if (!event) return;

  await User.findByIdAndUpdate(event.referrerId, { $inc: { referralCount: 1 } });

  const referrer = await User.findById(event.referrerId).select('permanentPdfAccess');
  if (!referrer) return;

  const completedInWindow = await ReferralEvent.countDocuments({
    referrerId:  referrer._id,
    isCompleted: true,
  });
  const milestoneTarget = await getReferralMilestoneCount();

  if (completedInWindow >= milestoneTarget) {
    // One-time milestone grant: once permanently unlocked, do not grant again.
    const unlocked = await User.findOneAndUpdate(
      { _id: referrer._id, permanentPdfAccess: { $ne: true } },
      { $set: { permanentPdfAccess: true } },
      { new: true },
    ).select('_id');

    if (!unlocked) return;

    // Grant +23 days Pro subscription to the referrer (additive)
    await extendOrGrantProSubscription(
      String(referrer._id),
      23,
      'referral',
      '[referral] Failed to grant +23-day Pro reward',
    );
  }
};

const grantPlanForDays = async (
  userId: string,
  tier: PlanTier,
  days: number,
  grantSource: 'trial' | 'referral',
  logPrefix: string,
): Promise<void> => {
  try {
    const planDef = getPlanDefinition(tier);

    const plan = await Plan.findOneAndUpdate(
      { tier },
      {
        $set: {
          name:              planDef.name,
          imageUploadLimit:  planDef.imageUploadLimit,
          alertLimit:        planDef.alertLimit,
          pdfEnabled:        planDef.pdfEnabled,
          weeklyEmailAlerts: planDef.weeklyEmailAlerts,
          monthlyPrice:      planDef.pricing.monthly,
          annualPrice:       planDef.pricing.annual,
          trialDays:         planDef.trialDays,
        },
        $setOnInsert: { tier },
      },
      { upsert: true, new: true },
    );

    // Cancel any existing active/pending subs
    await Subscription.updateMany(
      { userId, status: { $in: ['active', 'pending'] } },
      { $set: { status: 'cancelled', cancelDate: new Date() } },
    );

    const now = new Date();
    const periodEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await Subscription.create({
      userId,
      planId:           plan._id,
      billingCycle:     'monthly',
      grantSource,
      activationDate:   now,
      currentPeriodEnd: periodEnd,
      nextBillingDate:  periodEnd,
      status:           grantSource === 'trial' ? 'trialing' : 'active',
      ...(grantSource === 'trial' ? { trialReminderStages: [] } : {}),
      ...(grantSource === 'trial' ? { trialEndDate: periodEnd } : {}),
    });

    // Top up the user's monitoring credits and alert quota
    await Promise.all([
      topUpCredits(userId, planDef.imageUploadLimit),
      topUpAlerts(userId, planDef.alertLimit),
    ]);
  } catch (error) {
    console.error(logPrefix, error);
    throw error;
  }
};

/**
 * Extends the user's current active/trialing subscription by `days`.
 * If no active subscription exists, creates a fresh Pro subscription for `days`.
 */
const extendOrGrantProSubscription = async (
  userId: string,
  days: number,
  grantSource: 'trial' | 'referral',
  logPrefix: string,
): Promise<void> => {
  try {
    const existing = await Subscription.findOne({
      userId,
      status: { $in: ['active', 'trialing'] },
    }).sort({ createdAt: -1 });

    const bonusMs = days * 24 * 60 * 60 * 1000;

    if (existing) {
      const base   = existing.currentPeriodEnd ?? new Date();
      const newEnd = new Date(base.getTime() + bonusMs);
      await Subscription.findByIdAndUpdate(existing._id, {
        currentPeriodEnd: newEnd,
        nextBillingDate:  newEnd,
        ...(grantSource === 'trial' ? { trialReminderStages: [] } : {}),
      });
    } else {
      await grantPlanForDays(userId, 'pro', days, grantSource, logPrefix);
    }

    // Top up quota for the bonus days (use Pro plan limits)
    const proDef = getPlanDefinition('pro');
    await Promise.all([
      topUpCredits(userId, proDef.imageUploadLimit),
      topUpAlerts(userId, proDef.alertLimit),
    ]);
  } catch (error) {
    console.error(logPrefix, error);
    throw error;
  }
};

// ─── Internal helper — called from auth.controller on all registrations ─────
export const grantLoginProAccess = async (newUserId: string): Promise<void> => {
  await grantPlanForDays(
    newUserId,
    'pro',
    7,
    'trial',
    '[login] Failed to grant 7-day Pro access',
  );
};

// ─── Internal helper — called from auth.controller on referral verifications ─
/**
 * Provision a free 1-month Premium subscription for a newly verified
 * referred user.  This replaces any current trial/subscription window.
 */
export const grantFreeMonthPremium = async (newUserId: string): Promise<void> => {
  await grantPlanForDays(
    newUserId,
    'premium',
    30,
    'referral',
    '[referral] Failed to grant free premium month',
  );
};
