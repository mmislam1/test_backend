import { Request, Response, NextFunction } from 'express';
import { yandexSearchService } from './yandex-search.service';
import { pdfService } from './pdf.service';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';
import { User, Reward } from '../../models';

export class YandexSearchController {
  
  findMatches = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new AppError('Image file is required', StatusCodes.BAD_REQUEST);
      const userId = req.user?.id;
      if (!userId) throw new AppError('Unauthorized', StatusCodes.UNAUTHORIZED);

      // 1. Validate User Status & Credits
      const user = await User.findById(userId).select('isActive credits referralCount permanentPdfAccess');
      if (!user) throw new AppError('User not found', StatusCodes.NOT_FOUND);
      
      if (!user.isActive) {
        throw new AppError('Your account is currently inactive.', StatusCodes.FORBIDDEN);
      }
      if (user.credits <= 0) {
        throw new AppError('Insufficient credits. Please upgrade your plan.', StatusCodes.PAYMENT_REQUIRED);
      }

      // 2. Perform Search & Deduct Credit
      const matches = await yandexSearchService.searchAndSave(req.file.buffer, userId);

      // 3. Check PDF Reward Eligibility
      const pdfReward = await Reward.findOne({ slug: 'pdf-generator', isActive: true });
      let pdfBase64: string | undefined = undefined;

      const hasPdfUnlocked = !!pdfReward && (user.permanentPdfAccess || user.referralCount >= pdfReward.referralsRequired);

      if (hasPdfUnlocked) {
        // Generate the PDF only if they have the reward unlocked
        pdfBase64 = await pdfService.generateResultsPdf(matches);
      }

      // 4. Return Response
      res.status(StatusCodes.OK).json({
        success: true,
        data: {
          matchesFound: matches.length,
          matches,
        },
        // Frontend can ignore this if undefined, or trigger a download if present
        pdfDownload: pdfBase64 
      });

    } catch (error) {
      next(error);
    }
  };
}

export const yandexSearchController = new YandexSearchController();