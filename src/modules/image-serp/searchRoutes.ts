import { Router } from 'express';
import multer from 'multer';
import { handleNewSearch } from './searchController';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { planMiddleware } from '../../common/middlewares/plan.middleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/search', authMiddleware, planMiddleware, upload.single('image'), handleNewSearch);

export default router;