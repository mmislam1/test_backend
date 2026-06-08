# Billing Frontend Integration Guide

This document describes the billing system exposed by the backend for frontend use.

## Base Paths

- Billing API base path: `/api/v1/billing`
- Paddle webhook path: `/api/v1/webhooks/paddle`
- Protected billing routes require `Authorization: Bearer <jwt>`

## Source Of Truth

- Paddle is the source of truth for payment collection, renewals, and subscription lifecycle events.
- The backend stores a normalized local subscription snapshot for frontend reads.
- The frontend should treat `GET /api/v1/billing/subscription` as the canonical billing page payload.
- After checkout or some mutations, webhook processing may lag briefly. Use `POST /api/v1/billing/sync` when immediate reconciliation is needed.

## Core Concepts

- `planId` = the plan active right now.
- `nextPlanId` = the plan that should activate on the next renewal.
- `billingCycle` = current active cycle.
- `nextBillingCycle` = renewal cycle if a future change is staged.
- `cancelDate` has dual meaning:
  - active/trialing/past_due with auto-renew off: future end-of-period date
  - cancelled: actual cancellation date
- `nextBillingDate` is the expected renewal date for Paddle-managed subscriptions.

## Access Rules

- Access-bearing statuses:
  - `active`
  - `trialing`
  - `past_due`
- Non-access statuses:
  - `paused`
  - `cancelled`
  - `expired`
  - `pending`
- Local non-Paddle trial/referral subscriptions can expire independently of Paddle.

## Plan Change Rules

- Upgrades apply immediately.
- Downgrades are scheduled for the next billing period.
- If a downgrade is scheduled:
  - current access stays on the current plan
  - `nextPlan` becomes the future lower plan
  - `planChangeEffectiveAt` becomes the next renewal date
- If auto-renew is off:
  - `nextPlan` is `null`
  - `nextBillingCycle` is `null`
  - the UI should show an end date instead of a renewal plan
- If auto-renew is on and there is no staged change:
  - `nextPlan` matches the current plan
  - `nextBillingCycle` matches the current cycle

## Credits And Alerts Rules

- `credits` is the remaining usable balance for monitoring/search operations.
- Credits add up and carry over. They are not reset each period.
- Credits top up on:
  - new paid activation
  - renewal into a new billing period
  - immediate upgrades
- Credits do not top up when a downgrade is only scheduled.
- `usage.imagesUsedThisMonth` is a calendar-month metric, not a renewal-period metric.
- `usage.imageUploadLimit` is the plan definition, not the remaining balance.
- For frontend calculations, `credits` is the balance source of truth.
- `alertLimit = 0` means unlimited alerts at the plan-definition level.
- Internal unlimited alert sentinel is `alertsRemaining = -1`, but that field is not returned by billing endpoints.

## Copy-Ready Types

```ts
export type PlanTier = 'starter' | 'pro' | 'premium';
export type BillingCycle = 'monthly' | 'annual';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'cancelled'
  | 'expired'
  | 'pending'
  | 'past_due'
  | 'paused';

export type UserSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'paused';

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  imageUploadLimit: number;
  resultViewLimit: number;
  alertLimit: number;
  pdfEnabled: boolean;
  weeklyEmailAlerts: boolean;
  features: string[];
  pricing: {
    monthly: number;
    annual: number;
  };
  trialDays: number;
  paddleMonthlyPriceId?: string;
  paddleAnnualPriceId?: string;
  paddleTrialPriceId?: string;
}

export interface BillingSubscriptionPayload {
  id: string;
  status: SubscriptionStatus | null;
  paddleStatus: UserSubscriptionStatus | null;
  hasAccess: boolean;
  billingCycle: BillingCycle;
  grantSource: 'trial' | 'referral' | 'paid';
  isTrial: boolean;
  isTrialing: boolean;
  isPastDue: boolean;
  trialEndsAt: string | null;
  trialDaysLeft: number;
  activationDate: string;
  currentPeriodEnd: string | null;
  nextBillingDate: string | null;
  cancelDate: string | null;
  autoRenewEnabled: boolean;
  nextPlan: PlanDefinition | null;
  nextBillingCycle: BillingCycle | null;
  hasScheduledPlanChange: boolean;
  planChangeEffectiveAt: string | null;
  paddleManaged: boolean;
}

export interface BillingSubscriptionResponse {
  success: true;
  subscription: BillingSubscriptionPayload | null;
  plan: PlanDefinition;
  credits: number;
  usage: {
    imagesUsedThisMonth: number;
    imageUploadLimit: number;
    alertLimit: number;
    pdfEnabled: boolean;
  };
}

export interface BillingPlanLimitsResponse {
  success: true;
  tier: PlanTier;
  alertLimit: number;
  imageUploadLimit: number;
  pdfEnabled: boolean;
  permanentPdfAccess: boolean;
}

export interface BillingHistoryItem {
  amount: number;
  currency: string;
  status: 'completed' | 'failed' | 'refunded';
  paddleTransactionId: string;
  paddleSubscriptionId?: string;
  createdAt: string;
}
```

## Error Shapes

Most billing handlers return:

```json
{
  "success": false,
  "message": "...",
  "code": "OPTIONAL_CODE",
  "details": {}
}
```

Auth failures come through global error middleware and look like:

```json
{
  "success": false,
  "error": {
    "message": "Authentication required"
  }
}
```

Frontend error handling should support both shapes.

## Endpoint Reference

### GET `/api/v1/billing/plans`

Auth: no

Purpose:
- public plan catalog

Response:

```ts
{
  success: true;
  plans: PlanDefinition[];
}
```

Frontend notes:
- best source for pricing cards and feature comparison
- price IDs are included, but frontend should usually send `tier + billingCycle` to checkout rather than hardcoding `priceId`

### GET `/api/v1/billing/subscription`

Auth: yes

Purpose:
- current billing page snapshot
- current plan, renewal plan, access state, credits, and usage summary

Important semantics:
- `plan` = current effective plan for access
- `subscription.nextPlan` = renewal plan
- `subscription.autoRenewEnabled = false` means there is no next renewal
- `subscription.hasScheduledPlanChange = true` means current plan and renewal plan differ
- `subscription.planChangeEffectiveAt` is the date the staged renewal change should apply

Frontend rules:
- render current plan from top-level `plan`
- render future renewal from `subscription.nextPlan`
- if `autoRenewEnabled === false`, hide renewal-plan UI and show an end-of-access message from `cancelDate`
- if `status === 'past_due'` and `hasAccess === true`, keep paid features accessible

### GET `/api/v1/billing/plan-limits`

Auth: yes

Purpose:
- lightweight feature gating without loading the full billing page

Response:

```ts
{
  success: true;
  tier: PlanTier;
  alertLimit: number;
  imageUploadLimit: number;
  pdfEnabled: boolean;
  permanentPdfAccess: boolean;
}
```

Important note:
- this endpoint resolves tier from `active` or `trialing` subscriptions only
- for staged downgrades, auto-renew status, or `past_due`, prefer `GET /billing/subscription`

### POST `/api/v1/billing/paddle/checkout`

Auth: yes

Purpose:
- create a Paddle checkout transaction

Allowed body shapes:

```ts
{
  tier: PlanTier;
  billingCycle?: BillingCycle;
  withTrial?: boolean;
  discountId?: string;
}
```

or

```ts
{
  priceId: string;
  discountId?: string;
}
```

Success response:

```ts
{
  success: true;
  transactionId: string;
  checkoutUrl: string | null;
}
```

Frontend notes:
- use `transactionId` with Paddle inline or overlay checkout
- use `checkoutUrl` for redirect checkout
- trial use is decided by the backend, not guaranteed by the frontend request
- a Paddle-native trial is only offered when the user is eligible and a trial price is configured

Recommended flow:
1. Call checkout endpoint.
2. Open Paddle checkout.
3. On return, refetch `GET /billing/subscription`.
4. If webhook processing is delayed, call `POST /billing/sync` with `transactionId`.

### PATCH `/api/v1/billing/subscription`

Auth: yes

Purpose:
- change an existing Paddle-managed subscription

Request:

```ts
{
  tier: PlanTier;
  billingCycle?: BillingCycle;
}
```

Behavior:
- upgrades are immediate
- downgrades are staged for next renewal
- if a future change already exists, another PATCH can replace that staged renewal choice
- if auto-renew is off, the endpoint is blocked

Common success response:

```ts
{
  success: true;
  syncedLocally: boolean;
  changeTiming: 'immediate' | 'next_billing_period' | 'none';
  effectiveAt?: string | null;
  message: string;
  paddleSubscriptionId?: string;
}
```

Meaning of `changeTiming`:
- `immediate`: current plan changed now
- `next_billing_period`: renewal plan changed for the future
- `none`: requested state already matched the effective renewal state

Important error cases:
- `409 AUTO_RENEW_DISABLED`
- `409 PADDLE_SUBSCRIPTION_NOT_FOUND`
- `400` if subscription is not Paddle-managed
- `404` if there is no active subscription

Frontend rules:
- if `changeTiming === 'immediate'`, refresh current plan UI immediately
- if `changeTiming === 'next_billing_period'`, keep current plan UI unchanged and update only the renewal section
- never assume a downgrade changes the live plan instantly

### POST `/api/v1/billing/cancel`

Auth: yes

Purpose:
- for Paddle-managed subscriptions, turn auto-renew off at the next billing period
- does not immediately revoke access

Behavior:
- Paddle-managed subscription:
  - schedules end-of-period cancellation
  - clears `nextPlanId` and `nextBillingCycle`
  - sets `cancelDate` to the effective end date
- local non-Paddle subscription:
  - cancels immediately

Typical Paddle-managed response:

```ts
{
  success: true;
  effectiveAt: string | null;
  message: string;
}
```

Frontend rules:
- treat this as auto-renew off, not immediate plan loss
- after success, show current plan still active, no renewal plan, and end date from `effectiveAt` or `cancelDate`
- if the user already had a staged downgrade or billing-cycle change, remove that scheduled-change UI after success
- show the response `message` in a toast/banner; when a staged change existed, the backend message now explicitly says it was canceled
- invalidate and refetch `GET /billing/subscription` after success and expect:
  - `autoRenewEnabled = false`
  - `hasScheduledPlanChange = false`
  - `nextPlan = null`
  - `nextBillingCycle = null`
  - `planChangeEffectiveAt = null`
  - `cancelDate = effectiveAt`

### POST `/api/v1/billing/resume-auto-renew`

Auth: yes

Purpose:
- remove a scheduled end-of-period cancellation

Behavior:
- clears `cancelDate`
- clears any staged `nextPlanId` and `nextBillingCycle`
- renewal reverts to current plan and cycle

Response:

```ts
{
  success: true;
  message: string;
}
```

Frontend rule:
- after success, refetch `GET /billing/subscription` and expect `nextPlan` to match the current plan again

### POST `/api/v1/billing/pause`

Auth: yes

Purpose:
- schedule the subscription to pause at the end of the current billing period

Response:

```ts
{
  success: true;
  message: string;
}
```

Frontend rule:
- this is different from cancel; when pause takes effect the subscription becomes `paused` and access is suspended until resume

### POST `/api/v1/billing/resume`

Auth: yes

Purpose:
- resume a paused Paddle subscription immediately

Response:

```ts
{
  success: true;
  message: string;
}
```

Frontend rule:
- after success, refetch billing state because the backend waits for the webhook to finalize local status

### GET `/api/v1/billing/payment-method`

Auth: yes

Purpose:
- return a Paddle portal URL for payment-method update

Response:

```ts
{
  success: true;
  portalUrl: string;
  updateUrl: string;
}
```

Note:
- `portalUrl` and `updateUrl` are the same value

### GET `/api/v1/billing/portal`

Auth: yes

Purpose:
- return a general Paddle billing portal URL

Response:

```ts
{
  success: true;
  portalUrl: string;
}
```

### GET `/api/v1/billing/history?page=1&limit=20`

Auth: yes

Purpose:
- return payment history

Response:

```ts
{
  success: true;
  items: Array<{
    amount: number;
    currency: string;
    status: 'completed' | 'failed' | 'refunded';
    paddleTransactionId: string;
    paddleSubscriptionId?: string;
    createdAt: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

Notes:
- default `page = 1`
- default `limit = 20`
- maximum `limit = 100`

### POST `/api/v1/billing/sync`

Auth: yes

Purpose:
- pull latest subscription state from Paddle when the webhook has not landed yet

Request:

```ts
{
  transactionId?: string;
}
```

Response when synced:

```ts
{
  success: true;
  synced: true;
  status: string;
  plan: PlanTier;
  billingCycle: BillingCycle;
  paddleSubscriptionId: string;
}
```

Response when no subscription exists for the customer:

```ts
{
  success: true;
  synced: false;
  message: string;
}
```

Frontend rule:
- use after checkout success if `GET /billing/subscription` is still stale

## Recommended Screen Logic

Use `GET /api/v1/billing/subscription` as the canonical billing screen source.

Recommended mapping:

```ts
const currentPlan = data.plan;
const currentCycle = data.subscription?.billingCycle ?? 'monthly';
const autoRenewEnabled = data.subscription?.autoRenewEnabled ?? false;
const nextPlan = data.subscription?.nextPlan ?? null;
const nextCycle = data.subscription?.nextBillingCycle ?? null;
const planChangeEffectiveAt = data.subscription?.planChangeEffectiveAt ?? null;
const hasScheduledPlanChange = data.subscription?.hasScheduledPlanChange ?? false;
const credits = data.credits;
```

UI rules:
- if `subscription` is `null`, treat the user as unsubscribed
- if `autoRenewEnabled` is `true` and `hasScheduledPlanChange` is `false`, show renewal plan as the current plan
- if `hasScheduledPlanChange` is `true`, show separate current and next-renewal sections
- if `autoRenewEnabled` is `false`, do not show a next renewal plan
- if `status === 'past_due'` and `hasAccess === true`, show a billing warning but keep paid features accessible
- if `paddleManaged === false`, some renewal controls may not apply the same way as Paddle-managed subscriptions

## Background Events Relevant To UI

### Paddle Webhook Processing

- backend receives Paddle events at `/api/v1/webhooks/paddle`
- frontend never calls this route directly
- webhooks finalize many local subscription changes

Frontend implication:
- after checkout, resume, or some mutations, the UI may need a short refresh cycle
- use `POST /billing/sync` when immediate consistency is required

### Auto-Renew Reminder Worker

- default interval: 12 hours
- reminder stages: 7, 5, 3 days before end
- creates in-app billing alerts pointing to `/user/billing`

### Trial Reminder Worker

- default interval: 12 hours
- reminder stages: 7, 3, 1 days before trial end
- creates in-app billing alerts pointing to `/user/billing`

### Trial Expiry Worker

- default interval: 1 hour
- expires local non-Paddle trial/referral subscriptions after `currentPeriodEnd`
- does not manage Paddle-native trials

Frontend implication:
- a local trial can move to expired without direct user action, so billing state should be refreshed on app load and when protected billing UI renders

## Important Caveats

- top-level `plan` falls back to `starter` when the user has no active access
- `usage.imagesUsedThisMonth` is not the same as remaining credits
- `nextPlan` is a frontend convenience contract; current live access still comes from top-level `plan`
- `GET /billing/plan-limits` is useful for lightweight gating but not full billing-page truth
- some plan changes depend on Paddle webhook completion, so local state should be considered final only after refetch or sync

## Frontend Checklist

1. Use `GET /api/v1/billing/subscription` to render the billing page.
2. Use `GET /api/v1/billing/plans` for pricing cards and feature comparison.
3. Use `POST /api/v1/billing/paddle/checkout` for new purchases.
4. After checkout success, refetch billing data and call `POST /api/v1/billing/sync` if needed.
5. Use `PATCH /api/v1/billing/subscription` for plan or cycle changes.
6. Treat `changeTiming === 'next_billing_period'` as a renewal-plan update, not a current-plan update.
7. Treat `POST /api/v1/billing/cancel` as auto-renew off.
8. Use `POST /api/v1/billing/resume-auto-renew` to restore renewal.
9. Use `credits` as the remaining-balance number shown to the user.
10. Support both billing error shapes: top-level `message` and nested `error.message`.