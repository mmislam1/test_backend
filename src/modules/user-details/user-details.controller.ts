import { Request, Response } from 'express';
import { Search } from '../../models/searches';
import { Result } from '../../models/results';
import { Monitor } from '../../models/monitors';
import { Alert } from '../../models/alerts';
import { Folder } from '../../models/folders';
import { User } from '../../models/users';
import { Subscription } from '../../models/subscriptions';
import bcrypt from 'bcryptjs';
import { getSearchDetails } from './details.helper';
import { getPlanDefinition } from '../billing/billing.constants';
import type { PlanTier } from '../../models/plan';
import { normalizeStoredResultDetails } from '../../common/helpers/result-normalizer';
import { sendAdminResultStatusChangeEmail } from '../notifications/notification-email.service';

const REVIEWED_STATUSES = ['takedown_request', 'report_infringement', 'dispute', 'legal_support_request'];
const SETTINGS_USER_FIELDS =
  'name email affiliation jobTitle country phoneNumber role joiningDate notificationSettings';

const getActivePlanTier = async (userId: string): Promise<PlanTier> => {
  const activeSubscription = await Subscription.findOne({ userId, status: 'active' }).populate<{
    planId: { tier: PlanTier };
  }>('planId', 'tier');

  return (activeSubscription?.planId as any)?.tier ?? 'starter';
};

const normalizeDateRange = (dateInput?: string) => {
  if (!dateInput) return null;
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

export const getDashboardData = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;

    const userSearchIds = await Search.find({ userId }).distinct('_id');

    const [
      totalScans,
      activeMonitors,
      totalMatches,
      latestSearches,
      groupedResultProgress,
    ] = await Promise.all([
      Search.countDocuments({ userId }),
      Monitor.countDocuments({ userId, status: 'active' }),
      Result.countDocuments({ searchId: { $in: userSearchIds } }),
      Search.find({ userId }).sort({ date: -1 }).limit(3),
      Result.aggregate([
        { $match: { searchId: { $in: userSearchIds } } },
        {
          $group: {
            _id: '$searchId',
            totalResults: { $sum: 1 },
            reviewedResults: {
              $sum: {
                $cond: [{ $in: ['$reviewStatus', REVIEWED_STATUSES] }, 1, 0],
              },
            },
          },
        },
      ]),
    ]);

    const monitorComplete = groupedResultProgress.filter(
      (item: any) => item.totalResults > 0 && item.totalResults === item.reviewedResults,
    ).length;

    const pendingReview = groupedResultProgress.filter(
      (item: any) => item.totalResults > 0 && item.reviewedResults < item.totalResults,
    ).length;

    const latestSearchDetails = await Promise.all(latestSearches.map(s => getSearchDetails(s)));

    res.json({
      success: true,
      stats: {
        totalScans,
        activeMonitors,
        totalMatches,
        monitorComplete,
        pendingReview,
      },
      latestSearches: latestSearchDetails
    });
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
};

export const getAlerts = async (req: Request, res: Response) => {
  const alerts = await Alert.find({ userId: req?.user?.id }).sort({ timestamp: -1 });
  res.json({ success: true, alerts });
};

export const getHistory = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const searches = await Search.find({ userId: req?.user?.id })
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    const detailedHistory = await Promise.all(searches.map(s => getSearchDetails(s)));
    const total = await Search.countDocuments({ userId: req?.user?.id });

    res.json({
      success: true,
      data: detailedHistory,
      pagination: { total, page, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
};

export const getScanDetails = async (req: Request, res: Response) => {
  const userId = req?.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { searchId } = req.params;
  const search = await Search.findOne({ _id: searchId, userId });
  if (!search) return res.status(404).json({ success: false, message: 'Scan not found' });

  const details = await getSearchDetails(search);
  res.json({ success: true, details });
};

export const getSearchResults = async (req: Request, res: Response) => {
  const userId = req?.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { searchId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;

  const ownsSearch = await Search.exists({ _id: searchId, userId });
  if (!ownsSearch) {
    return res.status(404).json({ success: false, message: 'Search not found' });
  }

  const results = await Result.find({ searchId })
    .skip((page - 1) * limit)
    .limit(limit);

  const total = await Result.countDocuments({ searchId });

  res.json({
    success: true,
    results,
    pagination: { total, page, pages: Math.ceil(total / limit) }
  });
};

export const getMonitoringSearches = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 12;
    const skip = (page - 1) * limit;

    const nameQuery = ((req.query.name as string) || '').trim();
    const dateQuery = (req.query.date as string) || '';
    const folderIdQuery = ((req.query.folderId as string) || '').trim();

    const searchFilter: any = { userId };
    if (folderIdQuery) {
      searchFilter.folderId = folderIdQuery;
    }
    const dateRange = normalizeDateRange(dateQuery);
    if (dateRange) {
      searchFilter.date = { $gte: dateRange.start, $lte: dateRange.end };
    }

    let searches = await Search.find(searchFilter).sort({ date: -1 }).lean();

    if (nameQuery) {
      const lowerNameQuery = nameQuery.toLowerCase();
      searches = searches.filter((search: any) => {
        const fileName = (search.image || '').split('/').pop()?.toLowerCase() || '';
        return fileName.includes(lowerNameQuery);
      });
    }

    const total = searches.length;
    const paginatedSearches = searches.slice(skip, skip + limit);

    const searchIds = paginatedSearches.map((search: any) => search._id);
    const resultProgress = await Result.aggregate([
      { $match: { searchId: { $in: searchIds } } },
      {
        $group: {
          _id: '$searchId',
          totalResults: { $sum: 1 },
          reviewedResults: {
            $sum: {
              $cond: [{ $in: ['$reviewStatus', REVIEWED_STATUSES] }, 1, 0],
            },
          },
        },
      },
    ]);

    const progressMap = new Map(
      resultProgress.map((entry: any) => [String(entry._id), entry]),
    );

    const data = paginatedSearches.map((search: any) => {
      const fileName = (search.image || '').split('/').pop() || 'unknown_file';
      const progress = progressMap.get(String(search._id));
      const totalResults = progress?.totalResults || 0;
      const reviewedResults = progress?.reviewedResults || 0;

      return {
        searchId: search._id,
        image: search.image,
        status: search.status,
        time: search.date,
        folderId: search.folderId || null,
        fileName,
        totalResults,
        reviewedResults,
        analysisStatus:
          totalResults > 0 && reviewedResults === totalResults
            ? 'analysis_complete'
            : reviewedResults > 0
              ? 'monitoring'
              : 'pending_review',
      };
    });

    res.json({
      success: true,
      data,
      pagination: { total, page, pages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMonitoringSearchResults = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { searchId } = req.params;

    const search = await Search.findOne({ _id: searchId, userId });
    if (!search) {
      return res.status(404).json({ success: false, message: 'Search not found' });
    }

    const results = await Result.find({ searchId }).sort({ _id: -1 }).lean();
    const planTier = await getActivePlanTier(String(userId));
    const plan = getPlanDefinition(planTier);

    const resultViewLimit = Number(plan.resultViewLimit || 0);
    const hasResultLimit = Number.isFinite(resultViewLimit) && resultViewLimit > 0;

    const lockedResults = results.map((item: any, index: number) => {
      const normalizedDetails = normalizeStoredResultDetails(item?.details);
      const isLocked = hasResultLimit && index >= resultViewLimit;
      if (!isLocked) {
        return {
          ...item,
          details: normalizedDetails,
          isLocked: false,
        };
      }

      return {
        ...item,
        isLocked: true,
        details: {
          ...normalizedDetails,
          source: '',
          link: '',
        },
      };
    });

    const lockedCount = hasResultLimit ? Math.max(0, results.length - resultViewLimit) : 0;

    return res.json({
      success: true,
      search: {
        searchId: search._id,
        image: search.image,
        status: search.status,
        time: search.date,
        folderId: search.folderId || null,
        fileName: (search.image || '').split('/').pop() || 'unknown_file',
      },
      results: lockedResults,
      planLimits: {
        tier: planTier,
        maxResults: hasResultLimit ? resultViewLimit : 0,
        alertLimit: plan.alertLimit,
        pdfEnabled: plan.pdfEnabled,
        lockedCount,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateResultReviewStatus = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { resultId } = req.params;
    const { reviewStatus } = req.body;

    if (!REVIEWED_STATUSES.includes(reviewStatus) && reviewStatus !== 'not_reviewed') {
      return res.status(400).json({ success: false, message: 'Invalid review status' });
    }

    const result = await Result.findById(resultId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Result not found' });
    }

    const ownsSearch = await Search.exists({ _id: result.searchId, userId });
    if (!ownsSearch) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    result.reviewStatus = reviewStatus;
    result.reviewedAt = reviewStatus === 'not_reviewed' ? null : new Date();
    await result.save();

    // Notify admin of status change (fire-and-forget)
    if (reviewStatus !== 'not_reviewed') {
      const user = await User.findById(userId).select('name email').lean();
      sendAdminResultStatusChangeEmail({
        userName: (user as any)?.name ?? 'Unknown',
        userEmail: (user as any)?.email ?? '',
        resultId: String(result._id),
        searchId: String(result.searchId),
        matchImage: result.image,
        newStatus: reviewStatus,
      }).catch((err) => {
        console.error('[user-details] Failed to send admin status-change email:', err?.message ?? err);
      });
    }

    return res.json({ success: true, result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteMonitoringResult = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { resultId } = req.params;

    const result = await Result.findById(resultId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Result not found' });
    }

    const ownsSearch = await Search.exists({ _id: result.searchId, userId });
    if (!ownsSearch) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    await Result.deleteOne({ _id: resultId });

    return res.json({ success: true, deletedId: resultId });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const bulkDeleteMonitoringResults = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { resultIds } = req.body as { resultIds?: string[] };

    if (!Array.isArray(resultIds) || resultIds.length === 0) {
      return res.status(400).json({ success: false, message: 'resultIds is required' });
    }

    const results = await Result.find({ _id: { $in: resultIds } }).select('_id searchId');
    if (!results.length) {
      return res.status(404).json({ success: false, message: 'No matching results found' });
    }

    const searchIds = [...new Set(results.map((item: any) => String(item.searchId)))];
    const ownedSearches = await Search.find({ _id: { $in: searchIds }, userId }).select('_id');
    const ownedSet = new Set(ownedSearches.map((entry: any) => String(entry._id)));

    const deletableIds = results
      .filter((item: any) => ownedSet.has(String(item.searchId)))
      .map((item: any) => String(item._id));

    if (!deletableIds.length) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    await Result.deleteMany({ _id: { $in: deletableIds } });

    return res.json({
      success: true,
      deletedIds: deletableIds,
      deletedCount: deletableIds.length,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getFolders = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const folders = await Folder.find({ userId }).sort({ createdAt: -1 });
    return res.json({ success: true, folders });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createFolder = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const name = (req.body?.name || '').trim();

    if (!name) {
      return res.status(400).json({ success: false, message: 'Folder name is required' });
    }

    const folder = await Folder.create({ name, userId });
    return res.status(201).json({ success: true, folder });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'Folder with this name already exists' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteFolder = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { folderId } = req.params;

    const folder = await Folder.findOne({ _id: folderId, userId });
    if (!folder) {
      return res.status(404).json({ success: false, message: 'Folder not found' });
    }

    await Folder.deleteOne({ _id: folderId, userId });
    await Search.updateMany({ userId, folderId }, { $unset: { folderId: '' } });

    return res.json({ success: true, deletedId: folderId });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const assignSearchFolder = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { searchId } = req.params;
    const folderId = (req.body?.folderId || '').trim();

    const search = await Search.findOne({ _id: searchId, userId });
    if (!search) {
      return res.status(404).json({ success: false, message: 'Search not found' });
    }

    if (!folderId) {
      search.folderId = undefined;
      await search.save();
      return res.json({ success: true, search });
    }

    const folder = await Folder.findOne({ _id: folderId, userId });
    if (!folder) {
      return res.status(404).json({ success: false, message: 'Folder not found' });
    }

    search.folderId = folder._id as any;
    await search.save();

    return res.json({ success: true, search });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getReports = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;

    const searches = await Search.find({ userId }).sort({ date: -1 }).lean();
    const searchIds = searches.map((s) => s._id);

    const resultCounts = await Result.aggregate([
      { $match: { searchId: { $in: searchIds } } },
      { $group: { _id: '$searchId', total: { $sum: 1 } } },
    ]);

    const countMap: Record<string, number> = {};
    for (const entry of resultCounts) {
      countMap[String(entry._id)] = entry.total;
    }

    const reports = searches.map((s) => ({
      searchId: String(s._id),
      image: s.image,
      date: s.date,
      matchCount: countMap[String(s._id)] || 0,
    }));

    return res.json({ success: true, reports });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getSettings = async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req?.user?.id).select(SETTINGS_USER_FIELDS).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const unreadNotifications = await Alert.countDocuments({
      userId: req?.user?.id,
      isRead: false,
    });

    const safeNotificationSettings = {
      emailEnabled: user.notificationSettings?.emailEnabled ?? true,
      inAppEnabled: user.notificationSettings?.inAppEnabled ?? true,
      weeklyRescanEnabled: user.notificationSettings?.weeklyRescanEnabled ?? true,
      notifyOnNewMatches: user.notificationSettings?.notifyOnNewMatches ?? true,
      summaryFrequency: user.notificationSettings?.summaryFrequency ?? 'instant',
    };

    return res.json({
      success: true,
      settings: {
        profile: {
          name: user.name || '',
          email: user.email || '',
          affiliation: user.affiliation || '',
          jobTitle: user.jobTitle || '',
          country: user.country || '',
          phoneNumber: user.phoneNumber || '',
          role: user.role || 'general',
          joiningDate: user.joiningDate,
        },
        notifications: safeNotificationSettings,
        unreadNotifications,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateSettingsProfile = async (req: Request, res: Response) => {
  try {
    const { name, affiliation, jobTitle, country, phoneNumber } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req?.user?.id,
      {
        name: String(name).trim(),
        affiliation: affiliation ? String(affiliation).trim() : '',
        jobTitle: jobTitle ? String(jobTitle).trim() : '',
        country: country ? String(country).trim() : '',
        phoneNumber: phoneNumber ? String(phoneNumber).trim() : '',
      },
      { new: true },
    ).select(SETTINGS_USER_FIELDS);

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      profile: {
        name: updatedUser.name,
        email: updatedUser.email,
        affiliation: updatedUser.affiliation || '',
        jobTitle: updatedUser.jobTitle || '',
        country: updatedUser.country || '',
        phoneNumber: updatedUser.phoneNumber || '',
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateSettingsNotifications = async (req: Request, res: Response) => {
  try {
    const {
      emailEnabled,
      inAppEnabled,
      weeklyRescanEnabled,
      notifyOnNewMatches,
      summaryFrequency,
    } = req.body || {};

    const allowedFrequency = ['instant', 'daily', 'weekly'];
    const safeFrequency = allowedFrequency.includes(summaryFrequency)
      ? summaryFrequency
      : 'instant';

    const notificationSettings = {
      emailEnabled: Boolean(emailEnabled),
      inAppEnabled: Boolean(inAppEnabled),
      weeklyRescanEnabled: Boolean(weeklyRescanEnabled),
      notifyOnNewMatches: Boolean(notifyOnNewMatches),
      summaryFrequency: safeFrequency,
    };

    const updatedUser = await User.findByIdAndUpdate(
      req?.user?.id,
      { notificationSettings },
      { new: true },
    ).select('notificationSettings');

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({
      success: true,
      message: 'Notification preferences updated',
      notifications: {
        emailEnabled: updatedUser.notificationSettings?.emailEnabled ?? true,
        inAppEnabled: updatedUser.notificationSettings?.inAppEnabled ?? true,
        weeklyRescanEnabled: updatedUser.notificationSettings?.weeklyRescanEnabled ?? true,
        notifyOnNewMatches: updatedUser.notificationSettings?.notifyOnNewMatches ?? true,
        summaryFrequency: updatedUser.notificationSettings?.summaryFrequency ?? 'instant',
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateSettingsPassword = async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both passwords are required' });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const user = await User.findById(req?.user?.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.passwordHash) {
      return res.status(400).json({ success: false, message: 'Password login is not enabled for this account' });
    }

    const isMatch = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(String(newPassword), salt);
    await user.save();

    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const status = String(req.query.status || 'all');
    const q = String(req.query.q || '').trim();
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = parseInt(String(req.query.limit || '20'), 10);

    const filter: any = { userId };
    if (status === 'unread') filter.isRead = false;
    if (status === 'read') filter.isRead = true;
    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { message: { $regex: q, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Alert.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit),
      Alert.countDocuments(filter),
      Alert.countDocuments({ userId, isRead: false }),
    ]);

    return res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { notificationId } = req.params;

    const notification = await Alert.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    return res.json({ success: true, notification });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;

    const result = await Alert.updateMany(
      { userId, isRead: false },
      { $set: { isRead: true } },
    );

    return res.json({ success: true, updatedCount: result.modifiedCount || 0 });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteNotification = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const { notificationId } = req.params;

    const deleted = await Alert.findOneAndDelete({ _id: notificationId, userId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    return res.json({ success: true, deletedId: notificationId });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteAllNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const result = await Alert.deleteMany({ userId });
    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};