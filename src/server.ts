import mongoose from "mongoose";
import { config } from "./config/env";
import app from "./app";
import dns from "dns";
import { startWeeklyRescanWorker } from './modules/notifications/weekly-rescan.worker';
import { startTrialExpiryWorker } from './modules/billing/trial-expiry.worker';
import { startAutoRenewReminderWorker } from './modules/billing/auto-renew-reminder.worker';
import { startPendingPlanChangeWorker } from './modules/billing/pending-plan-change.worker';
import { startTrialReminderWorker } from './modules/billing/trial-reminder.worker';
import { syncPlanCatalogFromEnv } from './modules/billing/plan-catalog.service';

dns.setDefaultResultOrder("ipv4first");

const BILLING_LOG_COLLECTIONS = new Set(['alerts', 'payments', 'plans', 'subscriptions', 'users']);
const REDACTED_LOG_KEYS = /password|token|secret|authorization|email|signature|rawbody/i;

const sanitizeForLog = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeForLog(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => ([
        key,
        REDACTED_LOG_KEYS.test(key) ? '[REDACTED]' : sanitizeForLog(entry),
      ])),
    );
  }
  return value;
};

const safeSerializeForLog = (value: unknown, maxLength = 4000): string => {
  try {
    const serialized = JSON.stringify(sanitizeForLog(value));
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}...<truncated ${serialized.length - maxLength} chars>`
      : serialized;
  } catch {
    return String(value);
  }
};

const bootstrap = async () => {
  try {
    mongoose.set('debug', (collectionName: string, method: string, query: unknown, doc: unknown, options: unknown) => {
      if (!BILLING_LOG_COLLECTIONS.has(collectionName)) {
        return;
      }

      console.log(`[Billing][DB] ${collectionName}.${method} | ${safeSerializeForLog({ query, doc, options })}`);
    });

    await mongoose.connect(process.env.MONGO_URI || "");
    console.log("🌿 MongoDB Connected");

    await syncPlanCatalogFromEnv();

    app.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      startWeeklyRescanWorker();
      startTrialExpiryWorker();
      startAutoRenewReminderWorker();
      startPendingPlanChangeWorker();
      startTrialReminderWorker();
    });
  } catch (err) {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  }
};

bootstrap();
