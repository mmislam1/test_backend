import { Router } from 'express';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { isAdminMiddleware } from '../../common/middlewares/admin.middleware';
import {
  deleteXxScheduledChange,
  getXxHistory,
  getXxPlans,
  getXxPortal,
  getXxSubscription,
  getXxUpdates,
  patchXxAutoRenew,
  patchXxSubscription,
  patchXxUpdateRead,
  postXxCheckout,
  postXxSync,
  postXxTrialExtension,
} from './xxbilling.controller';

const router = Router();

router.get('/plans', getXxPlans);
router.get('/subscription', authMiddleware, getXxSubscription);
router.post('/checkout', authMiddleware, postXxCheckout);
router.patch('/subscription', authMiddleware, patchXxSubscription);
router.delete('/subscription/scheduled-change', authMiddleware, deleteXxScheduledChange);
router.patch('/auto-renew', authMiddleware, patchXxAutoRenew);
router.post('/sync', authMiddleware, postXxSync);
router.get('/history', authMiddleware, getXxHistory);
router.get('/updates', authMiddleware, getXxUpdates);
router.patch('/updates/:logId/read', authMiddleware, patchXxUpdateRead);
router.get('/portal', authMiddleware, getXxPortal);
router.post('/trial/extend', authMiddleware, isAdminMiddleware, postXxTrialExtension);

export default router;
