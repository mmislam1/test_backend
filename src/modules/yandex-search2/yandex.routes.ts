import { Router } from 'express';
import { yandexController } from './yandex.controller';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { uploadMiddleware } from '../../common/middlewares/upload.middleware';
import { planMiddleware } from '../../common/middlewares/plan.middleware';

const router = Router();

router.post(
  '/search',
  authMiddleware,
  planMiddleware,
  uploadMiddleware.single('image'),
  yandexController.search
);

export const yandexRouter = router;