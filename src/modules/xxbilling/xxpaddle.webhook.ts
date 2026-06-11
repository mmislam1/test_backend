import { Request, Response } from 'express';
import crypto from 'crypto';
import { handleXxPaddleEvent, writeXxBillingLog } from './xxbilling.service';

const verifyXxPaddleSignature = (
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
  const timestampMs = parseInt(ts, 10) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > toleranceMs) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(h1));
};

export const handleXxPaddleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const signature = req.headers['paddle-signature'] as string | undefined;
    const rawBody = (req as any).rawBody as string | undefined;
    const secret =
      process.env.XX_PADDLE_WEBHOOK_SECRET?.trim() ||
      process.env.PADDLE_WEBHOOK_SECRET?.trim() ||
      '';

    if (!signature || !rawBody) {
      res.status(400).send('Missing paddle-signature header or raw body');
      return;
    }
    if (!secret) {
      res.status(500).send('XX Paddle webhook secret is not configured');
      return;
    }
    if (!verifyXxPaddleSignature(signature, rawBody, secret)) {
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

    const eventType = String(event?.event_type ?? '');
    const paddleEventId = event?.event_id ?? event?.id;
    const data = event?.data;
    res.status(200).send('OK');

    setImmediate(async () => {
      try {
        await handleXxPaddleEvent({ eventType, paddleEventId, data });
      } catch (error: any) {
        await writeXxBillingLog({
          level: 'error',
          eventType: 'xx.paddle.webhook_failed',
          message: error?.message || 'XX Paddle webhook processing failed.',
          paddleEventId,
          metadata: { eventType },
        });
      }
    });
  } catch (error: any) {
    console.error('[XX Paddle] Webhook handler error:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
};
