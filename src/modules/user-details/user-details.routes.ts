import { Router } from 'express';
import * as Controller from './user-details.controller';
import { authMiddleware } from '../../common/middlewares/auth.middleware';

const router = Router();

router.get('/dashboard', authMiddleware, Controller.getDashboardData);
router.get('/alerts', authMiddleware, Controller.getAlerts);
router.get('/history', authMiddleware, Controller.getHistory);
router.get('/scan/:searchId', authMiddleware, Controller.getScanDetails);
router.get('/scan/:searchId/results', authMiddleware, Controller.getSearchResults);
router.get('/monitoring', authMiddleware, Controller.getMonitoringSearches);
router.get('/monitoring/:searchId/results', authMiddleware, Controller.getMonitoringSearchResults);
router.patch('/monitoring/result/:resultId/status', authMiddleware, Controller.updateResultReviewStatus);
router.delete('/monitoring/result/:resultId', authMiddleware, Controller.deleteMonitoringResult);
router.post('/monitoring/results/bulk-delete', authMiddleware, Controller.bulkDeleteMonitoringResults);
router.get('/folders', authMiddleware, Controller.getFolders);
router.post('/folders', authMiddleware, Controller.createFolder);
router.delete('/folders/:folderId', authMiddleware, Controller.deleteFolder);
router.patch('/search/:searchId/folder', authMiddleware, Controller.assignSearchFolder);
router.get('/reports', authMiddleware, Controller.getReports);
router.get('/settings', authMiddleware, Controller.getSettings);
router.patch('/settings/profile', authMiddleware, Controller.updateSettingsProfile);
router.patch('/settings/notifications', authMiddleware, Controller.updateSettingsNotifications);
router.patch('/settings/password', authMiddleware, Controller.updateSettingsPassword);
router.get('/notifications', authMiddleware, Controller.getNotifications);
router.patch('/notifications/read-all', authMiddleware, Controller.markAllNotificationsRead);
router.patch('/notifications/:notificationId/read', authMiddleware, Controller.markNotificationRead);
router.delete('/notifications', authMiddleware, Controller.deleteAllNotifications);
router.delete('/notifications/:notificationId', authMiddleware, Controller.deleteNotification);

export default router;