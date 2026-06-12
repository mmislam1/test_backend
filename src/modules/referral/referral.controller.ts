import { Request, Response } from 'express';
import { User } from '../../models/users';
import { ReferralEvent } from '../../models/referral-event';
import { Reward } from '../../models/rewards';
import {
  xxExtendOrGrantProReward,
  xxGrantFreeMonthPremium,
  xxGrantLoginProAccess,
} from '../xxbilling/xxbilling.service';

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
    await xxExtendOrGrantProReward(String(referrer._id), 23);
  }
};

// ─── Internal helper — called from auth.controller on all registrations ─────
export const grantLoginProAccess = async (newUserId: string): Promise<void> => {
  await xxGrantLoginProAccess(newUserId);
};

// ─── Internal helper — called from auth.controller on referral verifications ─
/**
 * Provision a free 1-month Premium subscription for a newly verified
 * referred user.  This replaces any current trial/subscription window.
 */
export const grantFreeMonthPremium = async (newUserId: string): Promise<void> => {
  await xxGrantFreeMonthPremium(newUserId);
};
