import { Request, Response } from 'express';
import crypto from 'crypto';
import { XXPaddleService } from './xxpaddle.service';
import { xxLogBilling, xxSafeSerializeForLog } from './xxbilling.logger';

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
  toleranceMs = 5 * 60 * 1000,
): boolean => {
  const parts = signatureHeader.split(';');
  let ts = '';
  let h1 = '';
  for (const part of parts) {
    if (part.startsWith('ts=')) ts = part.substring(3);
    if (part.startsWith('h1=')) h1 = part.substring(3);
  }
  if (!ts || !h1) return false;

  const tsMs = parseInt(ts, 10) * 1000;
  if (Number.isNaN(tsMs) || Date.now() - tsMs > toleranceMs) return false;

  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(h1));
};

export const handleXXPaddleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const signature = req.headers['paddle-signature'] as string | undefined;
    const secret = process.env.PADDLE_WEBHOOK_SECRET as string;
    const rawBody = (req as any).rawBody as string | undefined;

    if (!signature || !rawBody) {
      res.status(400).send('Missing paddle-signature header or raw body');
      return;
    }

    if (!secret) {
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

    const eventType = String(event.event_type || '');
    const data = event.data;
    console.log(`[XXPaddle] Received event: ${eventType} | summary=${xxSafeSerializeForLog(summarizeWebhookData(data))}`);
    res.status(200).send('OK');

    setImmediate(async () => {
      try {
        switch (eventType) {
          case 'transaction.completed':
            await XXPaddleService.handleTransactionCompleted(data);
            break;
          case 'transaction.payment_failed':
            await XXPaddleService.handleTransactionFailed(data);
            break;
          case 'adjustment.created':
          case 'adjustment.updated':
            await XXPaddleService.handleAdjustmentCreated(data);
            break;
          case 'subscription.created':
            await XXPaddleService.handleSubscriptionCreated(data);
            break;
          case 'subscription.trialing':
            await XXPaddleService.handleSubscriptionTrialing(data);
            break;
          case 'subscription.activated':
            await XXPaddleService.handleSubscriptionActivated(data);
            break;
          case 'subscription.updated':
            await XXPaddleService.handleSubscriptionUpdated(data);
            break;
          case 'subscription.past_due':
            await XXPaddleService.handleSubscriptionPastDue(data);
            break;
          case 'subscription.paused':
            await XXPaddleService.handleSubscriptionPaused(data);
            break;
          case 'subscription.resumed':
            await XXPaddleService.handleSubscriptionResumed(data);
            break;
          case 'subscription.canceled':
            await XXPaddleService.handleSubscriptionCanceled(data);
            break;
          default:
            await xxLogBilling({
              event: 'webhook_unhandled',
              source: 'paddle',
              level: 'warn',
              message: `Unhandled Paddle event: ${eventType}`,
              metadata: summarizeWebhookData(data),
            });
        }

        console.log(`[XXPaddle] Completed event: ${eventType}`);
      } catch (error: any) {
        await xxLogBilling({
          event: 'webhook_processing_failed',
          source: 'paddle',
          level: 'error',
          message: error?.message || `Failed to process Paddle event ${eventType}.`,
          metadata: { eventType, summary: summarizeWebhookData(data) },
        });
      }
    });
  } catch (error) {
    console.error('[XXPaddle] Webhook handler error:', error);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
};
