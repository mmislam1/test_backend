import { Types } from 'mongoose';

export interface DashboardStats {
  totalContent: number;
  underAnalysis: number;
  analysisComplete: number;
  memberCount: number;
  activeSubscriptions: number;
  searchesToday: number;
  revenueThisMonth: number;
  recentActivity: RecentActivityItem[];
}

export interface RecentActivityItem {
  type: 'search' | 'subscription' | 'user_joined' | 'payment';
  userId: Types.ObjectId;
  userName: string;
  userEmail: string;
  timestamp: Date;
  description: string;
  details?: any;
}

export interface UserListItem {
  _id: Types.ObjectId;
  name: string;
  email: string;
  status: 'active' | 'inactive';
  subscription?: {
    tier: string;
    planName?: string;
    status: string;
    grantSource?: string;
    billingCycle?: string;
    trialEndDate?: Date;
    trialDaysLeft?: number;
  };
  joiningDate: Date;
  searchCount: number;
}

export interface UserDetailResponse {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phoneNumber?: string;
  affiliation?: string;
  jobTitle?: string;
  country?: string;
  joiningDate: Date;
  role: string;
  isActive: boolean;
  isApproved: boolean;
  credits: number;
  monitors: number;
  subscriptionId?: Types.ObjectId;
  subscriptionStatus?: string;
  subscription?: any;
  searchCount: number;
  searches: any[];
  referralCode: string;
  referralCount: number;
}

export interface SearchListItem {
  _id: Types.ObjectId;
  image: string;
  fileName?: string;
  uploaderId: Types.ObjectId;
  uploaderName: string;
  status: string;
  discoveryCount: number;
  uploadDate: Date;
}

export interface PaginationOptions {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface MonthlySearchData {
  year: number;
  month: number;
  count: number;
}

export interface UsageStats {
  totalSearches: number;
  searchesThisMonth: number;
  searchesByMonth: MonthlySearchData[];
}

export type AnalyticsDateRangePreset = '7d' | '30d' | '90d';

export interface WebsiteAnalyticsTimeseriesPoint {
  date: string;
  visitors: number;
  activeUsers: number;
  pageViews: number;
  sessions: number;
}

export interface WebsiteAnalyticsGeoPoint {
  label: string;
  value: number;
}

export interface WebsiteAnalyticsSourcePoint {
  label: string;
  sessions: number;
  users: number;
  engagementRate: number;
  bounceRate: number;
}

export interface WebsiteAnalyticsTechnologyPoint {
  label: string;
  sessions: number;
  users: number;
}

export interface WebsiteAnalyticsPagePoint {
  path: string;
  title: string;
  views: number;
  avgEngagementSeconds: number;
  engagementRate: number;
  bounceRate: number;
}

export interface WebsiteAnalyticsLandingPagePoint {
  landingPage: string;
  sessions: number;
  engagementRate: number;
  bounceRate: number;
  avgEngagementSeconds: number;
}

export interface WebsiteAnalyticsRealtimePoint {
  label: string;
  activeUsers: number;
}

export interface WebsiteAnalyticsRealtimePagePoint {
  path: string;
  activeUsers: number;
}

export interface WebsiteAnalyticsRealtimeSnapshot {
  totalActiveUsers: number;
  topCountries: WebsiteAnalyticsRealtimePoint[];
  topCities: WebsiteAnalyticsRealtimePoint[];
  devices: WebsiteAnalyticsRealtimePoint[];
  browsers: WebsiteAnalyticsRealtimePoint[];
  activePages: WebsiteAnalyticsRealtimePagePoint[];
}

export interface WebsiteAnalyticsSummary {
  totalVisitors: number;
  uniqueVisitors: number;
  activeVisitors: number;
  pageViews: number;
  sessions: number;
  engagementRate: number;
  bounceRate: number;
  averageSessionDurationSeconds: number;
}

export interface WebsiteAnalyticsResponse {
  range: AnalyticsDateRangePreset;
  generatedAt: string;
  summary: WebsiteAnalyticsSummary;
  dailyTraffic: WebsiteAnalyticsTimeseriesPoint[];
  trafficGrowth: WebsiteAnalyticsTimeseriesPoint[];
  topCountries: WebsiteAnalyticsGeoPoint[];
  topCities: WebsiteAnalyticsGeoPoint[];
  trafficSources: WebsiteAnalyticsSourcePoint[];
  referrers: WebsiteAnalyticsSourcePoint[];
  deviceUsage: WebsiteAnalyticsTechnologyPoint[];
  browserUsage: WebsiteAnalyticsTechnologyPoint[];
  operatingSystemUsage: WebsiteAnalyticsTechnologyPoint[];
  topPages: WebsiteAnalyticsPagePoint[];
  topContent: WebsiteAnalyticsPagePoint[];
  topLandingPages: WebsiteAnalyticsLandingPagePoint[];
  realtime: WebsiteAnalyticsRealtimeSnapshot;
}
