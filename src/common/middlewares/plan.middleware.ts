/**
 * Plan Middleware
 *
 * Single source of truth for feature access control.
 *
 * Access is granted when ANY of the following is true:
 *   1. Subscription document status is 'active' | 'trialing' | 'past_due'
 *   2. user.subscriptionStatus (Paddle-synced) is 'active'
 *
 * Attaches to req:
 *   req.planDef            — full PlanDefinition (limits, feature flags)
 *   req.planTier           — 'starter' | 'pro' | 'premium'
 *   req.accessVia          — 'subscription' | 'credits' (credits is legacy and no longer granted here)
 *   req.subscriptionStatus — raw status string from Subscription doc (or
 *                            user.subscriptionStatus if no doc found), or
 *                            undefined when access is unavailable
 *
 * Controllers that consume credits may still call deductCredit() when
 * req.accessVia === 'credits' in legacy flows.
 */

import { Request, Response, NextFunction } from 'express';
import { Subscription, type SubscriptionStatus } from '../../models/subscriptions';
import { User } from '../../models/users';
import { Search } from '../../models/searches';
import { getPlanDefinition, type PlanDefinition } from '../../modules/billing/billing.constants';
import { AppError } from '../errors/AppError';
import { StatusCodes } from 'http-status-codes';
import type { PlanTier } from '../../models/plan';
import { evaluateSubscriptionAccess, pickEffectiveSubscription } from '../helpers/subscription-access';
import {
  getXxPlanForMiddleware,
  getXxSubscriptionForMiddleware,
} from '../../modules/xxbilling/xxbilling.service';

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Subscription statuses that grant service access.
 * 'past_due' is included so users in Paddle's grace period keep working;
 * controllers can inspect req.subscriptionStatus and show a payment-due warning.
 */
const SUB_ACCESS_STATUSES: SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

// ─── Type augmentation ─────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      planDef?: PlanDefinition;
      planTier?: PlanTier;
      accessVia?: 'subscription' | 'credits';
      subscriptionStatus?: SubscriptionStatus | string;
    }
  }
}

// ─── Middleware ─────────────────────────────────────────────────────────────

export const planMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError('Authentication required', StatusCodes.UNAUTHORIZED));
    }

    // Fetch user doc and most-recent subscription in parallel
    const [user, sub, xxSub] = await Promise.all([
      User.findById(userId).select('isActive subscriptionStatus credits paddleSubscriptionId').lean(),
      Subscription.find({ userId })
        .sort({ activationDate: -1, createdAt: -1 })
        .sort({ createdAt: -1 })
        .populate<{ planId: { tier: PlanTier } }>('planId', 'tier')
        .populate<{ lockedPlanId: { tier: PlanTier } }>('lockedPlanId', 'tier')
        .lean(),
      getXxSubscriptionForMiddleware(userId),
    ]);

    if (!user) {
      return next(new AppError('User not found', StatusCodes.NOT_FOUND));
    }
    if (!user.isActive) {
      return next(new AppError('Your account is deactivated.', StatusCodes.FORBIDDEN));
    }

    const normalizeLegacyCredits = async (planCreditLimit: number) => {
      if ((user.credits ?? 0) >= 0) return;

      await User.findByIdAndUpdate(userId, {
        $set: { credits: Math.max(0, planCreditLimit) },
      });
    };

    const enforceMonthlyUploadLimit = async (limit: number) => {
      if (limit <= 0) return;
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const usedThisMonth = await Search.countDocuments({
        userId,
        date: { $gte: monthStart },
      });
      if (usedThisMonth >= limit) {
        throw new AppError(
          `PLAN_UPLOAD_LIMIT_REACHED: Monthly upload limit reached (${limit}/${limit}). Upgrade your plan to continue.`,
          StatusCodes.PAYMENT_REQUIRED,
        );
      }
    };

    // ── 1. Subscription document status + real-time period checks ───────
    if (xxSub) {
      const xxPlan = getXxPlanForMiddleware(xxSub.planTier as PlanTier);
      const tier = xxPlan.tier as PlanTier;
      const planDef = getPlanDefinition(tier);
      await normalizeLegacyCredits(xxPlan.monitors);
      await enforceMonthlyUploadLimit(xxPlan.monitors);
      req.planDef = {
        ...planDef,
        imageUploadLimit: xxPlan.monitors,
        alertLimit: xxPlan.alertLimit === null ? 0 : xxPlan.alertLimit,
      };
      req.planTier = tier;
      req.accessVia = 'subscription';
      req.subscriptionStatus = xxSub.status;
      return next();
    }

    const effectiveSub = pickEffectiveSubscription(sub as any[], {
      preferredSubscriptionId: (user as any)?.paddleSubscriptionId,
    });

    if (effectiveSub) {
      const { effectiveStatus, hasAccess } = evaluateSubscriptionAccess(
        effectiveSub as any,
        user.subscriptionStatus ?? null,
      );

      if (hasAccess && effectiveStatus && SUB_ACCESS_STATUSES.includes(effectiveStatus)) {
        const effectivePlanDoc = ((effectiveSub.cancelDate ? (effectiveSub as any).lockedPlanId : null) ?? (effectiveSub.planId as any)) as any;
        const tier: PlanTier = effectivePlanDoc?.tier ?? 'starter';
        const planDef = getPlanDefinition(tier);
        await normalizeLegacyCredits(planDef.imageUploadLimit);
        await enforceMonthlyUploadLimit(planDef.imageUploadLimit);
        req.planDef           = planDef;
        req.planTier          = tier;
        req.accessVia         = 'subscription';
        req.subscriptionStatus = effectiveStatus;
        return next();
      }
    }

    // ── 2. user.subscriptionStatus (Paddle-synced field on User doc) ──────
    if (user.subscriptionStatus === 'active') {
      // Paddle says active but no matching Subscription doc yet (webhook lag);
      // grant starter-level access until the doc is created.
      const planDef = getPlanDefinition('starter');
      await normalizeLegacyCredits(planDef.imageUploadLimit);
      await enforceMonthlyUploadLimit(planDef.imageUploadLimit);
      req.planDef           = planDef;
      req.planTier          = 'starter';
      req.accessVia         = 'subscription';
      req.subscriptionStatus = user.subscriptionStatus;
      return next();
    }

    // ── 3. No access ─────────────────────────────────────────────────────
    return next(
      new AppError(
        'No active subscription. Please subscribe to continue.',
        StatusCodes.PAYMENT_REQUIRED,
      ),
    );
  } catch (err) {
    next(err);
  }
};

// ─── Helper ────────────────────────────────────────────────────────────────

/**
/**
 * Atomically deduct one credit from the user.
 * Call this inside a controller after every successful search (monitoring).
 */
export const deductCredit = (userId: string): Promise<any> =>
  User.findByIdAndUpdate(userId, { $inc: { credits: -1 } });

/**
 * Atomically deduct one alert from the user's quota.
 * Only call when the alert type is quota-gated (new_match / scan_update);
 * prefer using createUserAlert() from alert.helper which handles both the
 * check and the deduction atomically.
 */
export const deductAlert = (userId: string): Promise<any> =>
  User.findByIdAndUpdate(userId, { $inc: { alertsRemaining: -1 } });
