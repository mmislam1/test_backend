import { createUserAlert } from '../../common/helpers/alert.helper';
import { Result } from '../../models/results';
import { Search } from '../../models/searches';
import { XXSubscription } from '../../models/xxsubscription';
import { User } from '../../models/users';
import { executeReverseImageSearch } from '../image-serp/serpApiService';
import { sendWeeklyRescanNotificationEmail } from './notification-email.service';
import { normalizeSerpMatchForResult } from '../../common/helpers/result-normalizer';
import { xxEvaluateSubscriptionAccess } from '../xxbilling/xxbilling.service';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 10 * 60 * 1000;
const PROCESS_BATCH_SIZE = 20;

const pickFileName = (imageUrl: string) => {
  const segment = (imageUrl || '').split('/').pop() || 'Uploaded image';
  return segment.split('?')[0] || 'Uploaded image';
};

const buildSignature = (entry: {
  image?: string;
  details?: { link?: string; title?: string; source?: string };
}) => {
  const primary = (entry.details?.link || '').trim();
  if (primary) return `link:${primary}`;

  return [
    `img:${(entry.image || '').trim()}`,
    `title:${(entry.details?.title || '').trim()}`,
    `source:${(entry.details?.source || '').trim()}`,
  ].join('|');
};

const hasSubscriptionAccess = async (userId: string, userSubscriptionStatus?: string | null) => {
  const latestSub = await XXSubscription.findOne({ userId })
    .sort({ createdAt: -1 })
    .select('status grantSource currentPeriodEnd paddleSubscriptionId')
    .lean();

  if (!latestSub) {
    return userSubscriptionStatus === 'active' || userSubscriptionStatus === 'trialing';
  }

  const { hasAccess } = xxEvaluateSubscriptionAccess(latestSub as any, userSubscriptionStatus ?? null);
  return hasAccess;
};

const processOneSearch = async (search: any) => {
  const user = await User.findById(search.userId).select('email notificationSettings name subscriptionStatus').lean();
  const nextScheduledAt = new Date(Date.now() + ONE_WEEK_MS);

  if (!user) {
    await Search.findByIdAndUpdate(search._id, {
      nextRescanAt: nextScheduledAt,
      lastRescanAt: new Date(),
    });
    return;
  }

  const accessAllowed = await hasSubscriptionAccess(String(search.userId), user.subscriptionStatus);
  if (!accessAllowed) {
    await Search.findByIdAndUpdate(search._id, {
      nextRescanAt: nextScheduledAt,
    });
    return;
  }

  const weeklyRescanEnabled = user.notificationSettings?.weeklyRescanEnabled ?? true;
  const emailEnabled = user.notificationSettings?.emailEnabled ?? true;
  const notifyOnNewMatches = user.notificationSettings?.notifyOnNewMatches ?? true;

  if (!weeklyRescanEnabled) {
    await Search.findByIdAndUpdate(search._id, {
      nextRescanAt: nextScheduledAt,
      lastRescanAt: new Date(),
    });
    return;
  }

  const [existingResults, apiResults] = await Promise.all([
    Result.find({ searchId: search._id }).lean(),
    executeReverseImageSearch(search.image),
  ]);

  const existingSignatures = new Set(
    existingResults.map((row: any) =>
      buildSignature({
        image: row.image,
        details: {
          link: row.details?.link,
          title: row.details?.title,
          source: row.details?.source,
        },
      }),
    ),
  );

  const newResultsPayload = apiResults
    .map((match: any) => {
      const normalized = normalizeSerpMatchForResult(match, search.image);
      return {
        searchId: search._id,
        image: normalized.image,
        details: normalized.details,
      };
    })
    .filter((entry: any) => !existingSignatures.has(buildSignature(entry)));

  if (newResultsPayload.length) {
    await Result.insertMany(newResultsPayload);

    const fileName = pickFileName(search.image);
    await createUserAlert(String(search.userId), {
      title: `New matches found for ${fileName}`,
      message: `Weekly re-scan found ${newResultsPayload.length} new match${newResultsPayload.length > 1 ? 'es' : ''}.`,
      type: 'new_match',
      isRead: false,
      actionUrl: `/user/searches/${search._id}`,
      metadata: {
        searchId: String(search._id),
        newMatchCount: newResultsPayload.length,
        trigger: 'weekly-rescan',
      },
    });

    if (emailEnabled && notifyOnNewMatches && user.email) {
      try {
        await sendWeeklyRescanNotificationEmail(user.email, {
          fileName,
          newMatchCount: newResultsPayload.length,
          searchId: String(search._id),
        });
      } catch (error) {
        // Email failure should not block result persistence/rescan scheduling.
        console.error('Weekly rescan email failed:', error);
      }
    }
  }

  await Search.findByIdAndUpdate(search._id, {
    lastRescanAt: new Date(),
    nextRescanAt: nextScheduledAt,
  });
};

const runWeeklyRescanCycle = async () => {
  try {
    const dueSearches = await Search.find({
      status: { $ne: 'failed' },
      nextRescanAt: { $lte: new Date() },
    })
      .sort({ nextRescanAt: 1 })
      .limit(PROCESS_BATCH_SIZE)
      .lean();

    for (const search of dueSearches) {
      try {
        await processOneSearch(search);
      } catch (error) {
        await Search.findByIdAndUpdate(search._id, {
          nextRescanAt: new Date(Date.now() + ONE_WEEK_MS),
        });
      }
    }
  } catch (error) {
    console.error('Weekly rescan cycle failed:', error);
  }
};

export const startWeeklyRescanWorker = () => {
  runWeeklyRescanCycle();
  setInterval(runWeeklyRescanCycle, WORKER_INTERVAL_MS);
};
