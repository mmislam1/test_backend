import { Router } from 'express';
import { yandexSearchController } from './yandex.controller';
import { uploadMiddleware } from '../../common/middlewares/upload.middleware';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { planMiddleware } from '../../common/middlewares/plan.middleware';

const router = Router();

router.post(
  '/detect',
  authMiddleware,
  planMiddleware,
  uploadMiddleware.single('image'),
  yandexSearchController.findMatches
);

export const yandexSearchRouter = router;