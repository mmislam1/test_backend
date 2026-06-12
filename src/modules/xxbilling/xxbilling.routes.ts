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
} from './xxbilling.controller';

const xxBillingRouter = Router();

xxBillingRouter.get('/plans', getPlans);
xxBillingRouter.get('/subscription', authMiddleware, getSubscription);
xxBillingRouter.get('/plan-limits', authMiddleware, getPlanLimits);
xxBillingRouter.post('/cancel', authMiddleware, cancelSubscription);
xxBillingRouter.patch('/subscription', authMiddleware, updateSubscription);
xxBillingRouter.post('/pause', authMiddleware, pauseSubscription);
xxBillingRouter.post('/resume', authMiddleware, resumeSubscription);
xxBillingRouter.post('/resume-auto-renew', authMiddleware, resumeAutoRenew);
xxBillingRouter.get('/payment-method', authMiddleware, getUpdatePaymentUrl);
xxBillingRouter.get('/portal', authMiddleware, getBillingPortalUrl);
xxBillingRouter.get('/history', authMiddleware, getBillingHistory);
xxBillingRouter.post('/paddle/checkout', authMiddleware, createPaddleCheckout);
xxBillingRouter.post('/sync', authMiddleware, syncSubscriptionFromPaddle);

export default xxBillingRouter;
