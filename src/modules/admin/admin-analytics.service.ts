import { google } from 'googleapis';
import { createPrivateKey } from 'node:crypto';
import {
  AnalyticsDateRangePreset,
  WebsiteAnalyticsLandingPagePoint,
  WebsiteAnalyticsPagePoint,
  WebsiteAnalyticsRealtimePagePoint,
  WebsiteAnalyticsRealtimePoint,
  WebsiteAnalyticsRealtimeSnapshot,
  WebsiteAnalyticsResponse,
  WebsiteAnalyticsSourcePoint,
  WebsiteAnalyticsTechnologyPoint,
  WebsiteAnalyticsTimeseriesPoint,
} from './admin.types';

type GaReportMetricMap = Record<string, number>;

type GaRow = {
  dimensionValues?: Array<{ value?: string | null }>;
  metricValues?: Array<{ value?: string | null }>;
};

const DATE_RANGE_PRESETS: Record<AnalyticsDateRangePreset, { startDate: string; endDate: string }> = {
  '7d': { startDate: '7daysAgo', endDate: 'today' },
  '30d': { startDate: '30daysAgo', endDate: 'today' },
  '90d': { startDate: '90daysAgo', endDate: 'today' },
};

const ANALYTICS_SCOPE = ['https://www.googleapis.com/auth/analytics.readonly'];

const INTERNAL_PATH_PREFIXES = ['/admin', '/en/admin', '/kr/admin', '/user', '/en/user', '/kr/user'];

const parseNumber = (value: string | null | undefined): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
};

const parsePercentage = (value: string | null | undefined): number => {
  const parsed = parseNumber(value);
  return Number((parsed * 100).toFixed(2));
};

const parseDuration = (value: string | null | undefined): number => {
  return Number(parseNumber(value).toFixed(2));
};

const normalizePath = (value: string): string => {
  const withoutQuery = value.split('?')[0] || value;
  const withoutHash = withoutQuery.split('#')[0] || withoutQuery;
  return withoutHash.trim().toLowerCase();
};

const sanitizePublicPath = (value: string): string => {
  const normalized = normalizePath(value) || '/';
  // Fix malformed double-locale paths such as /en/kr/login or /kr/en/login.
  const collapsed = normalized
    .replace(/^\/en\/kr\//, '/kr/')
    .replace(/^\/kr\/en\//, '/en/');

  return collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
};

const isInternalPath = (value: string): boolean => {
  const normalized = normalizePath(value);
  return INTERNAL_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
};

const isInternalReferrer = (value: string): boolean => {
  try {
    const url = new URL(value);
    return isInternalPath(url.pathname || '/');
  } catch {
    return /\/admin|\/user/i.test(value);
  }
};

const mapMetrics = (metricHeaders: string[], row: GaRow | undefined): GaReportMetricMap => {
  return metricHeaders.reduce<GaReportMetricMap>((accumulator, metricName, index) => {
    accumulator[metricName] = parseNumber(row?.metricValues?.[index]?.value);
    return accumulator;
  }, {});
};

const mapDimensions = (dimensionHeaders: string[], row: GaRow | undefined): Record<string, string> => {
  return dimensionHeaders.reduce<Record<string, string>>((accumulator, dimensionName, index) => {
    accumulator[dimensionName] = String(row?.dimensionValues?.[index]?.value || '');
    return accumulator;
  }, {});
};

const decodeBase64IfNeeded = (value: string): string => {
  // Some deployments store PEM material as base64 to avoid newline escaping issues.
  const maybeBase64 = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(maybeBase64) || maybeBase64.length % 4 !== 0) {
    return value;
  }

  try {
    const decoded = Buffer.from(maybeBase64, 'base64').toString('utf8');
    if (decoded.includes('BEGIN PRIVATE KEY') || decoded.includes('BEGIN RSA PRIVATE KEY')) {
      return decoded;
    }
  } catch {
    // Ignore invalid base64 content and fall back to the original value.
  }

  return value;
};

const normalizePrivateKey = (value: string): string => {
  let normalized = value.trim();

  // Handle keys wrapped in single or double quotes by env injectors.
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  normalized = decodeBase64IfNeeded(normalized)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  return normalized;
};

const assertValidPrivateKey = (value: string): void => {
  try {
    createPrivateKey({ key: value, format: 'pem' });
  } catch {
    throw new Error(
      'Invalid GA4_PRIVATE_KEY format. Ensure it is a valid PEM private key with preserved newlines (or a base64-encoded PEM).',
    );
  }
};

const formatGaDate = (value: string): string => {
  if (!/^\d{8}$/.test(value)) {
    return value;
  }

  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}-${month}-${day}`;
};

const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key} environment variable.`);
  }
  return value;
};

const normalizePropertyId = (value: string): string => {
  const normalized = value.trim().replace(/^properties\//i, '');
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Invalid GA4_PROPERTY_ID format. Use only the numeric GA4 property ID (or properties/<id>).');
  }
  return normalized;
};

const createAnalyticsClient = () => {
  const clientEmail = requiredEnv('GA4_CLIENT_EMAIL');
  const privateKey = normalizePrivateKey(requiredEnv('GA4_PRIVATE_KEY'));
  assertValidPrivateKey(privateKey);

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ANALYTICS_SCOPE,
  });

  return google.analyticsdata({ version: 'v1beta', auth });
};

export const getAnalyticsAccessDebugContext = () => {
  const clientEmail = process.env.GA4_CLIENT_EMAIL?.trim() || null;
  const rawPropertyId = process.env.GA4_PROPERTY_ID?.trim() || null;

  let resolvedProperty: string | null = null;
  if (rawPropertyId) {
    try {
      resolvedProperty = `properties/${normalizePropertyId(rawPropertyId)}`;
    } catch {
      resolvedProperty = rawPropertyId;
    }
  }

  return {
    clientEmail,
    property: resolvedProperty,
  };
};

const buildTimeseries = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
): WebsiteAnalyticsTimeseriesPoint[] => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);

    return {
      date: formatGaDate(dimensions.date || ''),
      visitors: Math.round(metrics.totalUsers ?? 0),
      activeUsers: Math.round(metrics.activeUsers ?? 0),
      pageViews: Math.round(metrics.screenPageViews ?? 0),
      sessions: Math.round(metrics.sessions ?? 0),
    };
  });
};

const buildSourceRows = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
  dimensionName: string,
): WebsiteAnalyticsSourcePoint[] => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);

    return {
      label: dimensions[dimensionName] || 'Unknown',
      sessions: Math.round(metrics.sessions ?? 0),
      users: Math.round(metrics.totalUsers ?? 0),
      engagementRate: parsePercentage(String(metrics.engagementRate ?? 0)),
      bounceRate: parsePercentage(String(metrics.bounceRate ?? 0)),
    };
  });
};

const buildTechnologyRows = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
  dimensionName: string,
): WebsiteAnalyticsTechnologyPoint[] => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);

    return {
      label: dimensions[dimensionName] || 'Unknown',
      sessions: Math.round(metrics.sessions ?? 0),
      users: Math.round(metrics.totalUsers ?? 0),
    };
  });
};

const buildPageRows = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
  options: { pathDimension: string; titleDimension?: string },
): WebsiteAnalyticsPagePoint[] => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);

    const rawPath = sanitizePublicPath(dimensions[options.pathDimension] || '/');
    const title = (options.titleDimension ? dimensions[options.titleDimension] : '') || rawPath;

    return {
      path: rawPath,
      title,
      views: Math.round(metrics.screenPageViews ?? 0),
      avgEngagementSeconds: parseDuration(String(metrics.averageSessionDuration ?? 0)),
      engagementRate: parsePercentage(String(metrics.engagementRate ?? 0)),
      bounceRate: parsePercentage(String(metrics.bounceRate ?? 0)),
    };
  });
};

const buildLandingRows = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
): WebsiteAnalyticsLandingPagePoint[] => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);

    return {
      landingPage: sanitizePublicPath(dimensions.landingPagePlusQueryString || '/'),
      sessions: Math.round(metrics.sessions ?? 0),
      engagementRate: parsePercentage(String(metrics.engagementRate ?? 0)),
      bounceRate: parsePercentage(String(metrics.bounceRate ?? 0)),
      avgEngagementSeconds: parseDuration(String(metrics.averageSessionDuration ?? 0)),
    };
  });
};

const buildGeoRows = (
  rows: GaRow[],
  metricHeaders: string[],
  dimensionHeaders: string[],
  dimensionName: 'country' | 'city',
) => {
  return rows.map((row) => {
    const metrics = mapMetrics(metricHeaders, row);
    const dimensions = mapDimensions(dimensionHeaders, row);
    return {
      label: dimensions[dimensionName] || 'Unknown',
      value: Math.round(metrics.totalUsers ?? 0),
    };
  });
};

const buildRealtimePointRows = (
  rows: GaRow[],
  dimensionHeaders: string[],
  dimensionName: string,
): WebsiteAnalyticsRealtimePoint[] => {
  return rows
    .map((row) => {
      const dimensions = mapDimensions(dimensionHeaders, row);
      return {
        label: dimensions[dimensionName] || 'Unknown',
        activeUsers: Math.round(parseNumber(row.metricValues?.[0]?.value)),
      };
    })
    .filter((item) => item.activeUsers > 0);
};

const buildRealtimePageRows = (
  rows: GaRow[],
  dimensionHeaders: string[],
): WebsiteAnalyticsRealtimePagePoint[] => {
  return rows
    .map((row) => {
      const dimensions = mapDimensions(dimensionHeaders, row);
      const path = sanitizePublicPath(dimensions.pagePath || '/');
      return {
        path,
        activeUsers: Math.round(parseNumber(row.metricValues?.[0]?.value)),
      };
    })
    .filter((item) => item.activeUsers > 0)
    .filter((item) => !isInternalPath(item.path));
};

const buildRealtimeSnapshot = async (
  analyticsData: ReturnType<typeof google.analyticsdata>,
  property: string,
  fallbackActiveUsers: number,
): Promise<WebsiteAnalyticsRealtimeSnapshot> => {
  const runRealtime = async (dimensionName?: string) => {
    try {
      const response = await analyticsData.properties.runRealtimeReport({
        property,
        requestBody: {
          dimensions: dimensionName ? [{ name: dimensionName }] : undefined,
          metrics: [{ name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: '8',
        },
      });
      return response.data;
    } catch {
      return null;
    }
  };

  const [totalData, countriesData, citiesData, devicesData, browsersData, pagesData] = await Promise.all([
    runRealtime(),
    runRealtime('country'),
    runRealtime('city'),
    runRealtime('deviceCategory'),
    runRealtime('browser'),
    runRealtime('pagePath'),
  ]);

  const realtimeTotal = totalData?.rows?.[0]?.metricValues?.[0]?.value;
  const totalActiveUsers = realtimeTotal == null
    ? fallbackActiveUsers
    : Math.round(parseNumber(realtimeTotal));
  const countriesHeaders = (countriesData?.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const citiesHeaders = (citiesData?.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const devicesHeaders = (devicesData?.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const browsersHeaders = (browsersData?.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const pagesHeaders = (pagesData?.dimensionHeaders || []).map((dimension) => dimension.name || '');

  const countries = buildRealtimePointRows(countriesData?.rows || [], countriesHeaders, 'country').slice(0, 6);
  const cities = buildRealtimePointRows(citiesData?.rows || [], citiesHeaders, 'city').slice(0, 6);
  const devices = buildRealtimePointRows(devicesData?.rows || [], devicesHeaders, 'deviceCategory').slice(0, 6);
  const browsers = buildRealtimePointRows(browsersData?.rows || [], browsersHeaders, 'browser').slice(0, 6);
  const activePages = buildRealtimePageRows(pagesData?.rows || [], pagesHeaders).slice(0, 8);

  return {
    totalActiveUsers,
    topCountries: countries.length ? countries : (totalActiveUsers > 0 ? [{ label: 'Unknown', activeUsers: totalActiveUsers }] : []),
    topCities: cities.length ? cities : (totalActiveUsers > 0 ? [{ label: 'Unknown', activeUsers: totalActiveUsers }] : []),
    devices: devices.length ? devices : (totalActiveUsers > 0 ? [{ label: 'Unknown', activeUsers: totalActiveUsers }] : []),
    browsers: browsers.length ? browsers : (totalActiveUsers > 0 ? [{ label: 'Unknown', activeUsers: totalActiveUsers }] : []),
    activePages,
  };
};

const computeActiveVisitorsRealtime = async (
  analyticsData: ReturnType<typeof google.analyticsdata>,
  property: string,
): Promise<number | null> => {
  try {
    const response = await analyticsData.properties.runRealtimeReport({
      property,
      requestBody: {
        metrics: [{ name: 'activeUsers' }],
      },
    });

    const activeUsers = parseNumber(response.data.rows?.[0]?.metricValues?.[0]?.value);
    return Math.round(activeUsers);
  } catch {
    return null;
  }
};

export const getWebsiteAnalytics = async (
  range: AnalyticsDateRangePreset,
): Promise<WebsiteAnalyticsResponse> => {
  const analyticsData = createAnalyticsClient();
  const propertyId = normalizePropertyId(requiredEnv('GA4_PROPERTY_ID'));
  const property = `properties/${propertyId}`;
  const dateRange = DATE_RANGE_PRESETS[range];

  const [summaryResponse, trafficTrendResponse, countriesResponse, citiesResponse, sourcesResponse, referrerResponse, deviceResponse, browserResponse, osResponse, topPagesResponse, topContentResponse, landingPagesResponse, activeRealtimeUsers] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        metrics: [
          { name: 'totalUsers' },
          { name: 'activeUsers' },
          { name: 'newUsers' },
          { name: 'screenPageViews' },
          { name: 'sessions' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'totalUsers' },
          { name: 'activeUsers' },
          { name: 'screenPageViews' },
          { name: 'sessions' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'city' }],
        metrics: [{ name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'pageReferrer' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'browser' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'operatingSystem' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
        ],
        orderBys: [
          { metric: { metricName: 'averageSessionDuration' }, desc: true },
          { metric: { metricName: 'screenPageViews' }, desc: true },
        ],
        limit: '10',
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [dateRange],
        dimensions: [{ name: 'landingPagePlusQueryString' }],
        metrics: [
          { name: 'sessions' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      },
    }),
    computeActiveVisitorsRealtime(analyticsData, property),
  ]);

  const summaryMetricHeaders = (summaryResponse.data.metricHeaders || []).map((metric) => metric.name || '');
  const summaryMetrics = mapMetrics(summaryMetricHeaders, summaryResponse.data.rows?.[0]);

  const trafficDimensionHeaders = (trafficTrendResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const trafficMetricHeaders = (trafficTrendResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const countriesDimensionHeaders = (countriesResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const countriesMetricHeaders = (countriesResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const citiesDimensionHeaders = (citiesResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const citiesMetricHeaders = (citiesResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const sourcesDimensionHeaders = (sourcesResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const sourcesMetricHeaders = (sourcesResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const referrerDimensionHeaders = (referrerResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const referrerMetricHeaders = (referrerResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const deviceDimensionHeaders = (deviceResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const deviceMetricHeaders = (deviceResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const browserDimensionHeaders = (browserResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const browserMetricHeaders = (browserResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const osDimensionHeaders = (osResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const osMetricHeaders = (osResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const topPagesDimensionHeaders = (topPagesResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const topPagesMetricHeaders = (topPagesResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const topContentDimensionHeaders = (topContentResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const topContentMetricHeaders = (topContentResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const landingDimensionHeaders = (landingPagesResponse.data.dimensionHeaders || []).map((dimension) => dimension.name || '');
  const landingMetricHeaders = (landingPagesResponse.data.metricHeaders || []).map((metric) => metric.name || '');

  const dailyTraffic = buildTimeseries(trafficTrendResponse.data.rows || [], trafficMetricHeaders, trafficDimensionHeaders);
  const summaryActiveUsers = Math.round(summaryMetrics.activeUsers ?? 0);
  const resolvedRealtimeUsers = activeRealtimeUsers === null ? summaryActiveUsers : activeRealtimeUsers;
  const realtime = await buildRealtimeSnapshot(analyticsData, property, resolvedRealtimeUsers);

  return {
    range,
    generatedAt: new Date().toISOString(),
    summary: {
      totalVisitors: Math.round(summaryMetrics.totalUsers ?? 0),
      uniqueVisitors: Math.round(summaryMetrics.newUsers ?? 0),
      activeVisitors: summaryActiveUsers,
      pageViews: Math.round(summaryMetrics.screenPageViews ?? 0),
      sessions: Math.round(summaryMetrics.sessions ?? 0),
      engagementRate: parsePercentage(String(summaryMetrics.engagementRate ?? 0)),
      bounceRate: parsePercentage(String(summaryMetrics.bounceRate ?? 0)),
      averageSessionDurationSeconds: parseDuration(String(summaryMetrics.averageSessionDuration ?? 0)),
    },
    dailyTraffic,
    trafficGrowth: dailyTraffic,
    topCountries: buildGeoRows(countriesResponse.data.rows || [], countriesMetricHeaders, countriesDimensionHeaders, 'country'),
    topCities: buildGeoRows(citiesResponse.data.rows || [], citiesMetricHeaders, citiesDimensionHeaders, 'city'),
    trafficSources: buildSourceRows(
      sourcesResponse.data.rows || [],
      sourcesMetricHeaders,
      sourcesDimensionHeaders,
      'sessionDefaultChannelGroup',
    ),
    referrers: buildSourceRows(
      referrerResponse.data.rows || [],
      referrerMetricHeaders,
      referrerDimensionHeaders,
      'pageReferrer',
    ).filter((item) => item.label && item.label !== '(not set)' && item.label !== '(direct)')
      .filter((item) => !isInternalReferrer(item.label)),
    deviceUsage: buildTechnologyRows(
      deviceResponse.data.rows || [],
      deviceMetricHeaders,
      deviceDimensionHeaders,
      'deviceCategory',
    ),
    browserUsage: buildTechnologyRows(
      browserResponse.data.rows || [],
      browserMetricHeaders,
      browserDimensionHeaders,
      'browser',
    ),
    operatingSystemUsage: buildTechnologyRows(
      osResponse.data.rows || [],
      osMetricHeaders,
      osDimensionHeaders,
      'operatingSystem',
    ),
    topPages: buildPageRows(
      topPagesResponse.data.rows || [],
      topPagesMetricHeaders,
      topPagesDimensionHeaders,
      { pathDimension: 'pagePath', titleDimension: 'pageTitle' },
    ).filter((item) => !isInternalPath(item.path)),
    topContent: buildPageRows(
      topContentResponse.data.rows || [],
      topContentMetricHeaders,
      topContentDimensionHeaders,
      { pathDimension: 'pagePath', titleDimension: 'pageTitle' },
    ).filter((item) => !isInternalPath(item.path)),
    topLandingPages: buildLandingRows(
      landingPagesResponse.data.rows || [],
      landingMetricHeaders,
      landingDimensionHeaders,
    ).filter((item) => !isInternalPath(item.landingPage)),
    realtime,
  };
};
