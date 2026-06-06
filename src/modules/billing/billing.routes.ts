import { Router } from 'express';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import {
  getPlans,
  getSubscription,
  getPlanLimits,
  cancelSubscription,
  createPaddleCheckout,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  resumeAutoRenew,
  getUpdatePaymentUrl,
  getBillingPortalUrl,
  getBillingHistory,
  syncSubscriptionFromPaddle,
} from './billing.controller';

const router = Router();

// Public — anyone can see available plans
router.get('/plans', getPlans);

// Protected — subscription lifecycle
router.get('/subscription',      authMiddleware, getSubscription);
router.get('/plan-limits',       authMiddleware, getPlanLimits);
router.post('/cancel',           authMiddleware, cancelSubscription);

// Upgrade / downgrade (Paddle-managed subscriptions only)
router.patch('/subscription',    authMiddleware, updateSubscription);

// Pause / resume
router.post('/pause',            authMiddleware, pauseSubscription);
router.post('/resume',           authMiddleware, resumeSubscription);
router.post('/resume-auto-renew', authMiddleware, resumeAutoRenew);

// Payment method update via Paddle portal
router.get('/payment-method',    authMiddleware, getUpdatePaymentUrl);
router.get('/portal',            authMiddleware, getBillingPortalUrl);
router.get('/history',           authMiddleware, getBillingHistory);

// Paddle checkout — initiates a real (or trial) payment session
router.post('/paddle/checkout',  authMiddleware, createPaddleCheckout);

// Sync subscription state from Paddle API (use after checkout when webhook hasn't fired)
router.post('/sync',             authMiddleware, syncSubscriptionFromPaddle);

export default router;
