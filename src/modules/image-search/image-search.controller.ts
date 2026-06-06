import { Request, Response, NextFunction } from "express";
import { imageSearchService } from "./image-search.service";
import { AppError } from "../../common/errors/AppError";
import { StatusCodes } from "http-status-codes";
import { deductCredit } from "../../common/middlewares/plan.middleware";

export class ImageSearchController {
  findMatches = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file)
        throw new AppError("Image required", StatusCodes.BAD_REQUEST);

      const planTier = req.planTier!;
      const results = await imageSearchService.detectExactMatches(
        req.file.buffer,
        planTier,
      );

      // Deduct one credit for credit-based access (atomic update)
      if (req.accessVia === 'credits') {
        await deductCredit(req.user!.id);
      }

      res.status(StatusCodes.OK).json({ success: true, data: results });
    } catch (error) {
      next(error);
    }
  };
}
export const imageSearchController = new ImageSearchController();
