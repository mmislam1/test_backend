import { Request, Response, NextFunction } from 'express';
import { ocrService } from './ocr.service';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';

export class OcrController {
  
  analyzeDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError('Document (Image or PDF) is required', StatusCodes.BAD_REQUEST);
      }

      const extractedText = await ocrService.extractText(req.file.buffer, req.file.mimetype);

      res.status(StatusCodes.OK).json({
        success: true,
        data: {
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          textSize: extractedText.length,
          text: extractedText,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}

export const ocrController = new OcrController();