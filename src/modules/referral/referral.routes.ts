import { Router } from 'express';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import {
  generateReferralCode,
  getReferralStatus,
} from './referral.controller';

const router = Router();

// POST /api/v1/referral/generate  — (re)activates a 24-h referral window
router.post('/generate', authMiddleware, generateReferralCode);

// GET  /api/v1/referral/status    — progress & rewards state for current user
router.get('/status', authMiddleware, getReferralStatus);

export default router;
