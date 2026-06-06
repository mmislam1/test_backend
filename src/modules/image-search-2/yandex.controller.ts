import { Request, Response, NextFunction } from 'express';
import { yandexSearchService } from './yandex.service';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';
import { deductCredit } from '../../common/middlewares/plan.middleware';

export class YandexSearchController {

  findMatches = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError('Image file is required', StatusCodes.BAD_REQUEST);
      }

      const userId = req.user!.id;
      const plan = req.planDef!;

      const results = await yandexSearchService.searchAndSave(
        req.file.buffer,
        req.file.originalname,
        userId,
      );

      await deductCredit(userId);

      res.status(StatusCodes.OK).json({
        success: true,
        plan: plan.tier,
        data: { ...results, totalFound: results.matches?.length ?? 0 },
      });
    } catch (error) {
      next(error);
    }
  };
}

export const yandexSearchController = new YandexSearchController();