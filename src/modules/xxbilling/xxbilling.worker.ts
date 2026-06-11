import { runXxBillingMaintenance } from './xxbilling.service';

const WORKER_INTERVAL_MS =
  parseInt(process.env.XX_BILLING_WORKER_INTERVAL_MS ?? '', 10) || 60 * 60 * 1000;

export const startXxBillingWorker = (): void => {
  console.log(`[XX Billing] Worker started (interval: ${WORKER_INTERVAL_MS / 60_000} min)`);
  runXxBillingMaintenance().catch((error) => {
    console.error('[XX Billing] Startup maintenance failed:', error);
  });
  setInterval(() => {
    runXxBillingMaintenance().catch((error) => {
      console.error('[XX Billing] Maintenance failed:', error);
    });
  }, WORKER_INTERVAL_MS);
};
