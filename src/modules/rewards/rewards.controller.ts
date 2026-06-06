import { Request, Response, NextFunction } from 'express';
import { User, Reward } from '../../models';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';

export class RewardsController {
  
  getRewardStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw new AppError('Unauthorized', StatusCodes.UNAUTHORIZED);
      }

      // 1. Fetch User (for their referral count) and all active Rewards concurrently
      const [user, rewards] = await Promise.all([
        User.findById(userId).select('referralCount permanentPdfAccess'),
        Reward.find({ isActive: true }).sort({ referralsRequired: 1 }) // Sort lowest to highest
      ]);

      if (!user) {
        throw new AppError('User not found', StatusCodes.NOT_FOUND);
      }

      const currentReferrals = user.referralCount || 0;

      // 2. Map the rewards into a clean, frontend-friendly format
      const rewardStatus = rewards.map((reward) => {
        const isPermanentlyUnlocked = reward.slug === 'pdf-generator' && !!user.permanentPdfAccess;
        const isUnlocked = isPermanentlyUnlocked || currentReferrals >= reward.referralsRequired;
        const remaining = isUnlocked ? 0 : reward.referralsRequired - currentReferrals;

        // Construct the API link dynamically based on the slug. 
        // Adjust the base path if your routing structure is different.
        const apiLink = `/api/v1/${reward.slug}`;

        return {
          id: reward._id,
          title: reward.title,
          slug: reward.slug,
          description: reward.description,
          referralsRequired: reward.referralsRequired,
          isUnlocked: isUnlocked,
          referralsRemaining: remaining,
          apiLink: apiLink
        };
      });

      // 3. Send the response
      res.status(StatusCodes.OK).json({
        success: true,
        data: {
          userReferrals: currentReferrals,
          rewards: rewardStatus
        }
      });

    } catch (error) {
      next(error);
    }
  };
}

export const rewardsController = new RewardsController();