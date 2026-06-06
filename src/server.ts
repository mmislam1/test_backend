import mongoose from "mongoose";
import { config } from "./config/env";
import app from "./app";
import dns from "dns";
import { startWeeklyRescanWorker } from './modules/notifications/weekly-rescan.worker';
import { startTrialExpiryWorker } from './modules/billing/trial-expiry.worker';
import { startAutoRenewReminderWorker } from './modules/billing/auto-renew-reminder.worker';
import { startTrialReminderWorker } from './modules/billing/trial-reminder.worker';

dns.setDefaultResultOrder("ipv4first");
// Database Connection
mongoose
  .connect(process.env.MONGO_URI || "")
  .then(() => console.log("🌿 MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  });

// Start Server
app.listen(config.port, () => {
  console.log(`🚀 Server running on http://localhost:${config.port}`);
  startWeeklyRescanWorker();
  startTrialExpiryWorker();
  startAutoRenewReminderWorker();
  startTrialReminderWorker();
});
