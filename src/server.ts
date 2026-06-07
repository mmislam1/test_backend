import mongoose from "mongoose";
import { config } from "./config/env";
import app from "./app";
import dns from "dns";
import { startWeeklyRescanWorker } from './modules/notifications/weekly-rescan.worker';
import { startTrialExpiryWorker } from './modules/billing/trial-expiry.worker';
import { startAutoRenewReminderWorker } from './modules/billing/auto-renew-reminder.worker';
import { startTrialReminderWorker } from './modules/billing/trial-reminder.worker';
import { syncPlanCatalogFromEnv } from './modules/billing/plan-catalog.service';

dns.setDefaultResultOrder("ipv4first");

const bootstrap = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || "");
    console.log("🌿 MongoDB Connected");

    await syncPlanCatalogFromEnv();

    app.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      startWeeklyRescanWorker();
      startTrialExpiryWorker();
      startAutoRenewReminderWorker();
      startTrialReminderWorker();
    });
  } catch (err) {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  }
};

bootstrap();
