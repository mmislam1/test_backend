import { Router } from 'express';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { rewardsController } from './rewards.controller';

const router = Router();

// GET /api/v1/rewards/status
// Returns all rewards, user's progress, and API endpoints
router.get(
  '/status',
  authMiddleware,
  rewardsController.getRewardStatus
);

export const rewardsRouter = router;