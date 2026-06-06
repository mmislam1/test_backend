import { Router } from 'express';
import { ocrController } from './ocr.controller';
import { ocrUploadMiddleware } from './ocr.middleware';
import { authMiddleware } from '../../common/middlewares/auth.middleware';

const router = Router();

// POST /api/v1/ocr/analyze
router.post(
  '/analyze',
  authMiddleware, // Identifies user based on JWT
  ocrUploadMiddleware.single('document'), // Note the field name is 'document'
  ocrController.analyzeDocument
);

export const ocrRouter = router;