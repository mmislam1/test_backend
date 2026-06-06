import { Request, Response, NextFunction } from 'express';
import { User, Reward } from '../../models';
import { AppError } from '../errors/AppError';
import { StatusCodes } from 'http-status-codes';

/**
 * Validates if the user has enough referrals to access a specific feature.
 * @param featureSlug - The unique identifier for the service (e.g., 'pdf-generator')
 */
export const validateServiceAccess = (featureSlug: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Get User ID from the request (attached previously by authMiddleware)
      const userId = req.user?.id;
      
      if (!userId) {
        throw new AppError('User identity not found in headers. Please login.', StatusCodes.UNAUTHORIZED);
      }

      // 2. Run Parallel Queries (Optimization: Fetch User and Reward at the same time)
      const [user, reward] = await Promise.all([
        User.findById(userId).select('referralCount role permanentPdfAccess'),
        Reward.findOne({ slug: featureSlug, isActive: true })
      ]);

      // 3. Validation: Does the reward/service exist?
      if (!reward) {
        throw new AppError(`Service '${featureSlug}' is not configured or is currently disabled.`, StatusCodes.NOT_FOUND);
      }

      // 4. Bypass for Admins (Industry Standard: Admins usually ignore referral locks)
      if (user?.role === 'admin') {
        return next();
      }

      if (!user) {
        throw new AppError('User profile no longer exists.', StatusCodes.NOT_FOUND);
      }

      // Permanent referral milestone unlock always wins for PDF/report reward.
      if (featureSlug === 'pdf-generator' && user.permanentPdfAccess) {
        return next();
      }

      // 5. The "Check": compare user's referrals to the service requirement
      if (user.referralCount < reward.referralsRequired) {
        const missing = reward.referralsRequired - user.referralCount;
        
        throw new AppError(
          `Access Denied. The ${reward.title} requires ${reward.referralsRequired} referrals. You need ${missing} more.`,
          StatusCodes.FORBIDDEN
        );
      }

      // 6. Success: User is authorized for this specific service
      next();
    } catch (error) {
      next(error);
    }
  };
};