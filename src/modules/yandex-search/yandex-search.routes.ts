import { Router } from 'express';
import { yandexSearchController } from './yandex-search.controller';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { uploadMiddleware } from '../../common/middlewares/upload.middleware';

const router = Router();

router.post(
  '/detect',
  authMiddleware,
  uploadMiddleware.single('image'),
  yandexSearchController.findMatches
);

export const yandexSearchRouter = router;