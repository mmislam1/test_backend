import type { XxBillingCycle } from './xxbilling.types';

const REDACTED_LOG_KEYS = /password|token|secret|authorization|email|signature|rawbody/i;

export const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const addBillingPeriod = (date: Date, billingCycle: XxBillingCycle): Date => {
  const next = new Date(date);
  if (billingCycle === 'annual') {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
};

export const isFutureDate = (value?: Date | string | null): boolean => {
  if (!value) return true;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
};

export const sanitizeXxLogValue = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeXxLogValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        REDACTED_LOG_KEYS.test(key) ? '[REDACTED]' : sanitizeXxLogValue(entry),
      ]),
    );
  }
  return value;
};

export const safeXxSerialize = (value: unknown, maxLength = 4000): string => {
  try {
    const serialized = JSON.stringify(sanitizeXxLogValue(value));
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}...<truncated ${serialized.length - maxLength} chars>`
      : serialized;
  } catch {
    return String(value);
  }
};

export const parsePaddleAmount = (value: unknown): number => {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return raw / 100;
};

export const isPaddlePriceId = (value: string): boolean =>
  /^pri_[a-z\d]{26}$/i.test(value.trim());

export const formatXxDate = (value?: Date | string | null): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
};
