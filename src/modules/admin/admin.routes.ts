import { Router } from 'express';
import { authMiddleware } from '../../common/middlewares/auth.middleware';
import { isAdminMiddleware } from '../../common/middlewares/admin.middleware';
import {
  getDashboard,
  getUsers,
  getUserDetails,
  getUserSearches,
  deactivateUser,
  getAllSearches,
  getSearchDetails,
  getUsage,
  getWebsiteAnalyticsReport,
} from './admin.controller';

const router = Router();

/**
 * All admin routes are protected by:
 * 1. authMiddleware - verifies valid JWT token
 * 2. isAdminMiddleware - verifies user has admin role
 */

// Dashboard
router.get('/dashboard', authMiddleware, isAdminMiddleware, getDashboard);

// Users management
router.get('/users', authMiddleware, isAdminMiddleware, getUsers);
router.get('/userDetails/:userId', authMiddleware, isAdminMiddleware, getUserDetails);
router.get('/userSearches/:userId', authMiddleware, isAdminMiddleware, getUserSearches);
router.post('/deactivate/:userId', authMiddleware, isAdminMiddleware, deactivateUser);

// Searches management
router.get('/searches', authMiddleware, isAdminMiddleware, getAllSearches);

// Search details for a specific search
router.get('/searchDetails/:searchId', authMiddleware, isAdminMiddleware, getSearchDetails);

// Usage statistics
router.get('/usage', authMiddleware, isAdminMiddleware, getUsage);

// Website analytics (GA4)
router.get('/analytics', authMiddleware, isAdminMiddleware, getWebsiteAnalyticsReport);

export const adminRouter = router;
