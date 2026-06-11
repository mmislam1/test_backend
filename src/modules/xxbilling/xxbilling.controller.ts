import { Request, Response } from 'express';
import {
  cancelXxScheduledChange,
  createXxCheckout,
  extendXxTrial,
  getLatestXxSubscription,
  getXxFrontendUpdates,
  getXxPaymentHistory,
  getXxPlansForFrontend,
  getXxPortalUrl,
  markXxFrontendUpdateRead,
  scheduleXxPlanChange,
  setXxAutoRenew,
  syncXxSubscriptionFromPaddle,
} from './xxbilling.service';

const getUserId = (req: Request): string => String(req.user?.id ?? '');

export const getXxPlans = async (_req: Request, res: Response) => {
  res.json({
    success: true,
    plans: getXxPlansForFrontend(),
    policy: {
      noRefunds: true,
      planChangesActivateAfterCurrentPeriod: true,
      annualDiscounts: { starter: 20, pro: 30, premium: 40 },
      downgradeDiscounts: false,
    },
  });
};

export const getXxSubscription = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, subscription: await getLatestXxSubscription(getUserId(req)) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || 'Server error' });
  }
};

export const postXxCheckout = async (req: Request, res: Response) => {
  try {
    const checkout = await createXxCheckout({
      userId: getUserId(req),
      tier: req.body?.tier,
      billingCycle: req.body?.billingCycle,
    });
    res.status(201).json({ success: true, checkout });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error?.message || 'Could not create checkout.' });
  }
};

export const patchXxSubscription = async (req: Request, res: Response) => {
  try {
    const subscription = await scheduleXxPlanChange({
      userId: getUserId(req),
      tier: req.body?.tier,
      billingCycle: req.body?.billingCycle,
    });
    res.json({ success: true, subscription });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error?.message || 'Could not schedule plan change.' });
  }
};

export const deleteXxScheduledChange = async (req: Request, res: Response) => {
  try {
    res.json({ success: true, subscription: await cancelXxScheduledChange(getUserId(req)) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error?.message || 'Could not cancel scheduled change.' });
  }
};

export const patchXxAutoRenew = async (req: Request, res: Response) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    res.json({
      success: true,
      subscription: await setXxAutoRenew({ userId: getUserId(req), enabled }),
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error?.message || 'Could not update auto-renew.' });
  }
};

export const postXxSync = async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      ...(await syncXxSubscriptionFromPaddle({
        userId: getUserId(req),
        transactionId: req.body?.transactionId,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || 'Could not sync Paddle subscription.' });
  }
};

export const getXxHistory = async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      ...(await getXxPaymentHistory(
        getUserId(req),
        Number(req.query.page || 1),
        Number(req.query.limit || 20),
      )),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || 'Could not load payment history.' });
  }
};

export const getXxUpdates = async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      ...(await getXxFrontendUpdates({
        userId: getUserId(req),
        unreadOnly: String(req.query.unreadOnly || '').toLowerCase() === 'true',
        page: Number(req.query.page || 1),
        limit: Number(req.query.limit || 20),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error?.message || 'Could not load billing updates.' });
  }
};

export const patchXxUpdateRead = async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      update: await markXxFrontendUpdateRead(getUserId(req), String(req.params.logId)),
    });
  } catch (error: any) {
    res.status(404).json({ success: false, message: error?.message || 'Update not found.' });
  }
};

export const postXxTrialExtension = async (req: Request, res: Response) => {
  try {
    const targetUserId = String(req.body?.userId || '').trim();
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const subscription = await extendXxTrial({
      userId: targetUserId,
      days: Number(req.body?.days),
      actorId: getUserId(req),
    });
    return res.json({ success: true, subscription });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error?.message || 'Could not extend trial.' });
  }
};

export const getXxPortal = async (req: Request, res: Response) => {
  try {
    const urls = await getXxPortalUrl(getUserId(req));
    res.json({ success: true, ...urls });
  } catch (error: any) {
    res.status(404).json({ success: false, message: error?.message || 'Could not create portal session.' });
  }
};
