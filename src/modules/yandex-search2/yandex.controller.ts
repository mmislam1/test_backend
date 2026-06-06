import { Request, Response, NextFunction } from 'express';
import { Reward } from '../../models';
import { User } from '../../models/users';
import { yandexService } from './yandex.service';
import { pdfService } from './pdf.service';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../../common/errors/AppError';
import { deductCredit } from '../../common/middlewares/plan.middleware';

export class YandexController {
  search = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const plan = req.planDef!;

      // Apply search (credit-based)
      let matches;
      if (req.file) {
        matches = await yandexService.searchByImage(userId, req.file.buffer.toString('base64'));
      } else {
        matches = await yandexService.searchByImage(userId, undefined, req.body.imageUrl);
      }

      // Deduct one credit for each search (always)
      await deductCredit(userId);

      // PDF generation: plan-based (pdfEnabled) OR referral milestone
      const pdfReward = await Reward.findOne({ slug: 'pdf-generator', isActive: true });
      let pdfData = null;
      if (plan.pdfEnabled) {
        pdfData = await pdfService.generateResultsPdf(matches);
      } else if (pdfReward) {
        // Legacy referral-based unlock
        const userDoc = await User.findById(userId).select('referralCount permanentPdfAccess').lean();
        if (userDoc && (userDoc.permanentPdfAccess || userDoc.referralCount >= pdfReward.referralsRequired)) {
          pdfData = await pdfService.generateResultsPdf(matches);
        }
      }

      res.status(StatusCodes.OK).json({
        success: true,
        plan: plan.tier,
        data: {
          matches,
          totalFound: matches.length,
        },
        ...(pdfData && { pdfDownload: pdfData }),
      });
    } catch (error) {
      next(error);
    }
  };
}
export const yandexController = new YandexController();