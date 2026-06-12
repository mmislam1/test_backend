import { XXBillingLog } from '../../models/xxbillinglog';

const REDACTED_LOG_KEYS = /password|token|secret|authorization|email|signature|rawbody/i;

const sanitizeForLog = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeForLog(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        REDACTED_LOG_KEYS.test(key) ? '[REDACTED]' : sanitizeForLog(entry),
      ]),
    );
  }
  return value;
};

export const xxSafeSerializeForLog = (value: unknown, maxLength = 4000): string => {
  try {
    const serialized = JSON.stringify(sanitizeForLog(value));
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}...<truncated ${serialized.length - maxLength} chars>`
      : serialized;
  } catch {
    return String(value);
  }
};

export const xxLogBilling = async ({
  userId,
  event,
  level = 'info',
  source,
  message,
  paddleSubscriptionId,
  paddleTransactionId,
  metadata,
}: {
  userId?: string;
  event: string;
  level?: 'info' | 'warn' | 'error';
  source: 'api' | 'paddle' | 'worker' | 'reward';
  message: string;
  paddleSubscriptionId?: string;
  paddleTransactionId?: string;
  metadata?: Record<string, any>;
}) => {
  const payload = {
    userId,
    event,
    level,
    source,
    message,
    paddleSubscriptionId,
    paddleTransactionId,
    metadata,
  };

  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleMethod(`[XXBilling] ${event} | ${xxSafeSerializeForLog(payload)}`);

  try {
    await XXBillingLog.create(payload);
  } catch (error) {
    console.error('[XXBilling] Failed to persist billing log:', error);
  }
};
