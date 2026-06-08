import { Request, Response } from 'express';
import crypto from 'crypto';
import { PaddleService } from './paddle.service';

const summarizeWebhookData = (data: any) => ({
  id: data?.id ?? null,
  status: data?.status ?? null,
  customerId: data?.customer_id ?? null,
  subscriptionId: data?.subscription_id ?? null,
  priceId: data?.items?.[0]?.price?.id ?? null,
  billingCycle: data?.billing_cycle?.interval ?? null,
  currentPeriodEnd: data?.current_billing_period?.ends_at ?? null,
  nextBilledAt: data?.next_billed_at ?? null,
  scheduledChange: data?.scheduled_change
    ? {
        action: data.scheduled_change.action ?? null,
        effectiveAt: data.scheduled_change.effective_at ?? null,
      }
    : null,
});

const verifyPaddleSignature = (
  signatureHeader: string,
  rawBody: string,
  secret: string,
  toleranceMs = 5 * 60 * 1000, // 5-minute replay-attack window (Paddle SDKs default to 5 s)
): boolean => {
  const parts = signatureHeader.split(';');
  let ts = '', h1 = '';
  for (const part of parts) {
    if (part.startsWith('ts=')) ts = part.substring(3);
    if (part.startsWith('h1=')) h1 = part.substring(3);
  }
  if (!ts || !h1) return false;

  // Replay-attack protection: reject events whose timestamp is outside the tolerance window.
  const tsMs = parseInt(ts, 10) * 1000;
  if (isNaN(tsMs) || Date.now() - tsMs > toleranceMs) return false;

  const payload = `${ts}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expectedHmac = hmac.digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(h1));
};

export const handlePaddleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const signature = req.headers['paddle-signature'] as string | undefined;
    const secret = process.env.PADDLE_WEBHOOK_SECRET as string;
    const rawBody = (req as any).rawBody as string | undefined;

    // Guard: missing headers / body before attempting crypto operations
    if (!signature || !rawBody) {
      res.status(400).send('Missing paddle-signature header or raw body');
      return;
    }

    if (!secret) {
      console.error('[Paddle] PADDLE_WEBHOOK_SECRET is not configured');
      res.status(500).send('Webhook secret not configured');
      return;
    }

    if (!verifyPaddleSignature(signature, rawBody, secret)) {
      res.status(401).send('Invalid webhook signature');
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).send('Invalid JSON body');
      return;
    }

    const eventType: string = event.event_type;
    const data = event.data;

    console.log(`[Paddle] Received event: ${eventType} | summary=${JSON.stringify(summarizeWebhookData(data))}`);

    // Acknowledge receipt immediately — Paddle requires a 200 response within 5 seconds.
    // All business logic runs asynchronously below so we never time out.
    res.status(200).send('OK');

    // Process the event asynchronously after the response is flushed.
    setImmediate(async () => {
      try {
        switch (eventType) {
          // ── Transaction events ───────────────────────────────────────────
          case 'transaction.completed':
            await PaddleService.handleTransactionCompleted(data);
            break;
          case 'transaction.payment_failed':
            await PaddleService.handleTransactionFailed(data);
            break;
          // Refunds in Paddle Billing v2 arrive as adjustments
          case 'adjustment.created':
          case 'adjustment.updated':
            await PaddleService.handleAdjustmentCreated(data);
            break;
          // ── Subscription lifecycle events ────────────────────────────────
          case 'subscription.created':
            await PaddleService.handleSubscriptionCreated(data);
            break;
          case 'subscription.trialing':
            await PaddleService.handleSubscriptionTrialing(data);
            break;
          case 'subscription.activated':
            await PaddleService.handleSubscriptionActivated(data);
            break;
          case 'subscription.updated':
            await PaddleService.handleSubscriptionUpdated(data);
            break;
          case 'subscription.past_due':
            await PaddleService.handleSubscriptionPastDue(data);
            break;
          case 'subscription.paused':
            await PaddleService.handleSubscriptionPaused(data);
            break;
          case 'subscription.resumed':
            await PaddleService.handleSubscriptionResumed(data);
            break;
          case 'subscription.canceled':
            await PaddleService.handleSubscriptionCanceled(data);
            break;
          default:
            console.log(`[Paddle] Unhandled event type: ${eventType}`);
        }

        console.log(`[Paddle] Completed event: ${eventType} | summary=${JSON.stringify(summarizeWebhookData(data))}`);
      } catch (error) {
        console.error(`[Paddle] Error processing event "${eventType}":`, error);
      }
    });
  } catch (error) {
    console.error('[Paddle] Webhook handler error:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
};