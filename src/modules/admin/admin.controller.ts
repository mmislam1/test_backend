import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../../models/users';
import { Search } from '../../models/searches';
import { Result } from '../../models/results';
import { XXSubscription } from '../../models/xxsubscription';
import { XXPayment } from '../../models/xxpayment';
import axios from 'axios';
import { getXXPlanDefinition } from '../xxbilling/xxbilling.constants';
import {
  AnalyticsDateRangePreset,
  DashboardStats,
  PaginationOptions,
  PaginatedResponse,
  UserListItem,
  UserDetailResponse,
  SearchListItem,
  RecentActivityItem,
} from './admin.types';
import { getAnalyticsAccessDebugContext, getWebsiteAnalytics } from './admin-analytics.service';

// Utility: Parse pagination params
const getPaginationOptions = (req: Request): PaginationOptions => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 10));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const getTrialDaysLeft = (trialEndDate?: Date | null): number | undefined => {
  if (!trialEndDate) {
    return undefined;
  }

  const diffMs = new Date(trialEndDate).getTime() - Date.now();
  if (Number.isNaN(diffMs)) {
    return undefined;
  }

  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
};

const toAdminSubscription = (subscription: any) => {
  if (!subscription) return undefined;
  const tier = subscription.planTier || 'starter';
  const plan = getXXPlanDefinition(tier);
  return {
    ...subscription,
    planId: { name: plan.name, tier },
    tier,
    planName: plan.name,
    trialDaysLeft: getTrialDaysLeft(subscription.trialEndDate),
  };
};

/**
 * GET /api/v1/admin/dashboard
 * Returns comprehensive dashboard statistics
 */
export const getDashboard = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Parallel queries
    const [
      totalSearches,
      underAnalysisCount,
      analysisCompleteCount,
      userCount,
      activeSubscriptions,
      searchesToday,
      monthlyPayments,
      recentSearches,
      recentSubscriptions,
      recentUsers,
      recentPayments,
    ] = await Promise.all([
      Search.countDocuments(),
      Search.countDocuments({ status: 'processing' }),
      Search.countDocuments({ status: 'completed' }),
      User.countDocuments({ role: 'general' }),
      XXSubscription.countDocuments({ status: 'active' }),
      Search.countDocuments({ date: { $gte: today } }),
      XXPayment.aggregate([
        { $match: { createdAt: { $gte: monthStart }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Search.find()
        .sort({ date: -1 })
        .limit(5)
        .populate('userId', 'name email'),
      XXSubscription.find({ createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('userId', 'name email'),
      User.find({ createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('name email joiningDate'),
      XXPayment.find({ createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('userId', 'name email'),
    ]);

    // Build recent activity
    const recentActivity: RecentActivityItem[] = [];

    recentSearches.forEach((search: any) => {
      recentActivity.push({
        type: 'search',
        userId: search.userId._id,
        userName: search.userId.name,
        userEmail: search.userId.email,
        timestamp: search.date,
        description: `Uploaded image search`,
        details: { searchId: search._id },
      });
    });

    recentSubscriptions.forEach((sub: any) => {
      recentActivity.push({
        type: 'subscription',
        userId: sub.userId._id,
        userName: sub.userId.name,
        userEmail: sub.userId.email,
        timestamp: sub.createdAt,
        description: `Subscribed to plan`,
        details: { subscriptionId: sub._id, status: sub.status },
      });
    });

    recentUsers.forEach((user: any) => {
      recentActivity.push({
        type: 'user_joined',
        userId: user._id,
        userName: user.name,
        userEmail: user.email,
        timestamp: user.joiningDate,
        description: `New user joined`,
      });
    });

    recentPayments.forEach((payment: any) => {
      recentActivity.push({
        type: 'payment',
        userId: payment.userId._id,
        userName: payment.userId.name,
        userEmail: payment.userId.email,
        timestamp: payment.createdAt,
        description: `Payment received`,
        details: { amount: payment.amount, status: payment.status },
      });
    });

    // Sort by timestamp descending
    recentActivity.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const dashboard: DashboardStats = {
      totalContent: totalSearches,
      underAnalysis: underAnalysisCount,
      analysisComplete: analysisCompleteCount,
      memberCount: userCount,
      activeSubscriptions,
      searchesToday,
      revenueThisMonth: monthlyPayments[0]?.total || 0,
      recentActivity: recentActivity.slice(0, 20), // Last 20 activities
    };

    res.status(200).json({ success: true, data: dashboard });
  } catch (error: any) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard statistics',
    });
  }
};

/**
 * GET /api/v1/admin/users
 * Returns paginated list of users with filtering
 */
export const getUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page, limit, skip } = getPaginationOptions(req);
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    // Build filter
    const filter: any = { role: 'general' };
    if (status) {
      filter.isActive = status === 'active';
    }
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    // Fetch data
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name email isActive isApproved joiningDate subscriptionId')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 }),
      User.countDocuments(filter),
    ]);

    // Count searches per user
    const userIds = users.map((u) => u._id);
    const searchCounts = await Search.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);

    const searchCountMap = new Map(
      searchCounts.map((sc: any) => [sc._id.toString(), sc.count]),
    );

    const fallbackSubscriptions = userIds.length
      ? await XXSubscription.find({ userId: { $in: userIds } })
          .sort({ activationDate: -1, createdAt: -1 })
      : [];

    const fallbackSubscriptionMap = new Map<string, any>();
    fallbackSubscriptions.forEach((subscription: any) => {
      const key = subscription.userId?.toString();
      if (key && !fallbackSubscriptionMap.has(key)) {
        fallbackSubscriptionMap.set(key, subscription);
      }
    });

    const userList: UserListItem[] = users.map((user: any) => {
      const resolvedSubscription = toAdminSubscription(fallbackSubscriptionMap.get(user._id.toString()));

      return {
      _id: user._id,
      name: user.name,
      email: user.email,
      status: user.isActive ? 'active' : 'inactive',
      subscription: resolvedSubscription
        ? {
            tier: (resolvedSubscription as any)?.tier || 'starter',
            planName: (resolvedSubscription as any)?.planName || '',
            status: (resolvedSubscription as any).status || 'pending',
            grantSource: (resolvedSubscription as any).grantSource || '',
            billingCycle: (resolvedSubscription as any).billingCycle || '',
            trialEndDate: (resolvedSubscription as any).trialEndDate || undefined,
            trialDaysLeft: getTrialDaysLeft((resolvedSubscription as any).trialEndDate),
          }
        : undefined,
      joiningDate: user.joiningDate,
      searchCount: searchCountMap.get(user._id.toString()) || 0,
    };
    });

    const response: PaginatedResponse<UserListItem> = {
      data: userList,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };

    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
};

/**
 * GET /api/v1/admin/userDetails/:userId
 * Returns detailed information for a specific user
 */
export const getUserDetails = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select(
        'name email phoneNumber affiliation jobTitle country joiningDate role isActive isApproved credits monitors subscriptionId subscriptionStatus referralCode referralCount',
      );

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Get user searches
    const searches = await Search.find({ userId })
      .sort({ date: -1 })
      .limit(10)
      .select('image status date');

    const searchCount = await Search.countDocuments({ userId });

    let effectiveSubscription: any = null;
    let effectiveSubscriptionId: any = null;

    if (!effectiveSubscription) {
      const latestSubscription = await XXSubscription.findOne({ userId })
        .sort({ activationDate: -1, createdAt: -1 });

      if (latestSubscription) {
        effectiveSubscription = toAdminSubscription(latestSubscription.toObject());
        effectiveSubscriptionId = latestSubscription._id;
      }
    }

    if (!effectiveSubscription && user.subscriptionStatus === 'trialing') {
      const trialSubscription = await XXSubscription.findOne({ userId, status: 'trialing' })
        .sort({ activationDate: -1, createdAt: -1 });

      if (trialSubscription) {
        effectiveSubscription = toAdminSubscription(trialSubscription.toObject());
        (effectiveSubscription as any).trialDaysLeft = getTrialDaysLeft((trialSubscription as any).trialEndDate);
        effectiveSubscriptionId = trialSubscription._id;
      } else {
        effectiveSubscription = {
          planId: { name: 'Pro', tier: 'pro' },
          grantSource: 'trial',
          status: 'trialing',
          billingCycle: 'trial',
          trialEndDate: null,
          trialDaysLeft: 0,
        };
      }
    }

    if (effectiveSubscription && (effectiveSubscription as any).trialEndDate && (effectiveSubscription as any).trialDaysLeft === undefined) {
      (effectiveSubscription as any).trialDaysLeft = getTrialDaysLeft((effectiveSubscription as any).trialEndDate);
    }

    const userDetails: UserDetailResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      affiliation: user.affiliation,
      jobTitle: user.jobTitle,
      country: user.country,
      joiningDate: user.joiningDate,
      role: user.role,
      isActive: user.isActive,
      isApproved: user.isApproved,
      credits: user.credits,
      monitors: user.monitors,
      subscriptionId: effectiveSubscriptionId,
      subscription: effectiveSubscription,
      subscriptionStatus: user.subscriptionStatus,
      searchCount,
      searches,
      referralCode: user.referralCode,
      referralCount: user.referralCount,
    };

    res.status(200).json({ success: true, data: userDetails });
  } catch (error: any) {
    console.error('Get user details error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user details' });
  }
};

/**
 * GET /api/v1/admin/userSearches/:userId
 * Returns paginated list of searches for a specific user
 */
export const getUserSearches = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { page, limit, skip } = getPaginationOptions(req);

    // Verify user exists
    const user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Fetch searches
    const [searches, total] = await Promise.all([
      Search.find({ userId })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .select('image status date'),
      Search.countDocuments({ userId }),
    ]);

    const response: PaginatedResponse<any> = {
      data: searches,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };

    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    console.error('Get user searches error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user searches' });
  }
};

/**
 * POST /api/v1/admin/deactivate/:userId
 * Deactivates a user account
 */
export const deactivateUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        isActive: false,
      },
      { new: true },
    );

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.status(200).json({
      success: true,
      message: `User ${user.email} has been deactivated`,
      data: { userId: user._id, email: user.email, isActive: user.isActive },
    });
  } catch (error: any) {
    console.error('Deactivate user error:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate user' });
  }
};

/**
 * GET /api/v1/admin/searches
 * Returns paginated list of all searches with filtering and searching
 */
export const getAllSearches = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { page, limit, skip } = getPaginationOptions(req);
    const status = req.query.status as string | undefined;
    const userName = req.query.userName as string | undefined;

    // Build filter
    const filter: any = {};
    if (status) {
      filter.status = status;
    }

    // If searching by user name, get user IDs first
    let userIds: any[] | undefined;
    if (userName) {
      const matchingUsers = await User.find({
        name: { $regex: userName, $options: 'i' },
      }).select('_id');
      userIds = matchingUsers.map((u) => u._id);
      filter.userId = { $in: userIds };
    }

    // Fetch searches with user info
    const [searches, total] = await Promise.all([
      Search.find(filter)
        .populate('userId', 'name email')
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .select('image status date userId'),
      Search.countDocuments(filter),
    ]);

    // Get discovery counts (results per search)
    const searchIds = searches.map((s) => s._id);
    const discoveryCounts = await Result.aggregate([
      { $match: { searchId: { $in: searchIds } } },
      { $group: { _id: '$searchId', count: { $sum: 1 } } },
    ]);

    const discoveryCountMap = new Map(
      discoveryCounts.map((dc: any) => [dc._id.toString(), dc.count]),
    );

    const searchList: SearchListItem[] = searches.map((search: any) => ({
      _id: search._id,
      image: search.image,
      fileName: search.image.split('/').pop() || 'unknown',
      uploaderId: search.userId._id,
      uploaderName: search.userId.name,
      status: search.status,
      discoveryCount: discoveryCountMap.get(search._id.toString()) || 0,
      uploadDate: search.date,
    }));

    const response: PaginatedResponse<SearchListItem> = {
      data: searchList,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };

    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    console.error('Get searches error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch searches' });
  }
};

/**
 * GET /api/v1/admin/usage
 * Returns search usage statistics: total searches, searches this month, and searches by month
 */
/**
 * GET /api/v1/admin/searchDetails/:searchId
 * Returns detailed information for a specific search including its results and status
 */
export const getSearchDetails = async (req: Request, res: Response): Promise<void> => {
  try {
    const searchId = req.params.searchId as string;

    // Validate searchId
    if (!searchId || !mongoose.Types.ObjectId.isValid(searchId)) {
      res.status(400).json({ success: false, error: 'Invalid search ID' });
      return;
    }

    // Fetch the search and uploader info
    const search = await Search.findById(searchId).populate('userId', 'name email');
    if (!search) {
      res.status(404).json({ success: false, error: 'Search not found' });
      return;
    }

    // Paginate results for this search
    const { page, limit, skip } = getPaginationOptions(req);

    const [results, total] = await Promise.all([
      Result.find({ searchId: search._id })
        .select('image details reviewStatus reviewedAt')
        .sort({ _id: 1 })
        .skip(skip)
        .limit(limit),
      Result.countDocuments({ searchId: search._id }),
    ]);

    const paginatedResults = {
      data: results,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };

    const response = {
      _id: search._id,
      image: search.image,
      status: search.status,
      uploader: search.userId
        ? {
            _id: (search.userId as any)._id,
            name: (search.userId as any).name,
            email: (search.userId as any).email,
          }
        : undefined,
      date: search.date,
      nextRescanAt: search.nextRescanAt,
      lastRescanAt: search.lastRescanAt,
      results: paginatedResults,
    };

    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    console.error('Get search details error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch search details' });
  }
};

export const getUsage = async (req: Request, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Get total searches
    const totalSearches = await Search.countDocuments();

    // Get searches this month
    const searchesThisMonth = await Search.countDocuments({
      date: { $gte: currentMonthStart, $lte: currentMonthEnd },
    });

    // Get searches by month for the last 12 months
    const searchesByMonth = await Search.aggregate([
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: {
          '_id.year': -1,
          '_id.month': -1,
        },
      },
      {
        $limit: 12,
      },
    ]);

    // Format the monthly data
    const monthlyData = searchesByMonth.map((item: any) => ({
      year: item._id.year,
      month: item._id.month,
      count: item.count,
    }));

    const response = {
      totalSearches,
      searchesThisMonth,
      searchesByMonth: monthlyData,
    };

    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    console.error('Get usage error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch usage statistics' });
  }
};

export const getWebsiteAnalyticsReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const rangeParam = String(req.query.range || '30d').trim().toLowerCase();
    const allowedRanges: AnalyticsDateRangePreset[] = ['7d', '30d', '90d'];
    const range = (allowedRanges.includes(rangeParam as AnalyticsDateRangePreset)
      ? rangeParam
      : '30d') as AnalyticsDateRangePreset;

    const analytics = await getWebsiteAnalytics(range);
    res.status(200).json({ success: true, data: analytics });
  } catch (error: any) {
    console.error('Get website analytics error:', error);

    const message = String(error?.message || '');
    const isPermissionError =
      error?.code === 403 ||
      /insufficient permissions/i.test(message) ||
      /does not have sufficient permissions/i.test(message) ||
      /permission denied/i.test(message);

    if (isPermissionError) {
      const debugContext = getAnalyticsAccessDebugContext();

      res.status(403).json({
        success: false,
        error:
          'GA4 access denied for this property. Grant the service account (GA4_CLIENT_EMAIL) at least Viewer access to this GA4 property and verify GA4_PROPERTY_ID is correct.',
        details: {
          ga4ClientEmail: debugContext.clientEmail,
          ga4Property: debugContext.property,
        },
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: message || 'Failed to fetch website analytics',
    });
  }
};
