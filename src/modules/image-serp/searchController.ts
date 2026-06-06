import { Request, Response } from 'express';
import { User } from '../../models/users';
import { Search } from '../../models/searches';
import { Result } from '../../models/results';
import { uploadImageToCloudinary } from './cloudinaryService';
import { executeReverseImageSearch } from './serpApiService';
import { deductCredit } from '../../common/middlewares/plan.middleware';
import { normalizeSerpMatchForResult, normalizeStoredResultDetails } from '../../common/helpers/result-normalizer';

export const handleNewSearch = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // planMiddleware guarantees req.planDef is set and access is allowed
    const plan = req.planDef!;

    // 1. Resolve image source
    const { imageUrl } = req.body;
    let targetImageUrl = '';

    if (imageUrl) {
      targetImageUrl = imageUrl;
    } else if (req.file) {
      try {
        targetImageUrl = await uploadImageToCloudinary(req.file.buffer, req.file.originalname);
      } catch (error: any) {
        return res.status(502).json({ error: `Failed to upload image: ${error?.message}` });
      }
    } else {
      return res.status(400).json({ error: 'Please provide an image file or an imageUrl.' });
    }

    // 2. Verify credits are available (plan.middleware already ran, but belt-and-suspenders)
    const user = await User.findById(userId).select('isActive credits').lean();
    if (!user || !user.isActive) return res.status(403).json({ error: 'Account deactivated' });
    if (user.credits <= 0) {
      return res.status(403).json({
        success: false,
        code: 'CREDITS_EXHAUSTED',
        message: 'You have no monitoring credits remaining. Please subscribe to a plan to continue.',
      });
    }

    // 4. Create search record
    const nextRescanAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const searchRecord = await Search.create({
      userId,
      image: targetImageUrl,
      status: 'processing',
      nextRescanAt,
    });

    try {
      // 5. Execute SerpApi search
      const apiResults = await executeReverseImageSearch(targetImageUrl);

      if (!apiResults.length) {
        searchRecord.status = 'completed';
        await searchRecord.save();
        await deductCredit(userId);
        return res.status(200).json({
          success: true,
          message: 'No matches found',
          searchId: searchRecord._id,
          results: [],
        });
      }

      // 6. Save all results to DB
      const resultsToInsert = apiResults.map((match: any) => {
        const normalized = normalizeSerpMatchForResult(match, targetImageUrl);

        return {
          searchId: searchRecord._id,
          image: normalized.image,
          details: normalized.details,
        };
      });
      const savedResults = await Result.insertMany(resultsToInsert);

      const totalFound = savedResults.length;
      const resultViewLimit = Number(plan.resultViewLimit || 0);
      const hasResultLimit = Number.isFinite(resultViewLimit) && resultViewLimit > 0;

      const resultsForResponse = savedResults.map((entry: any, index: number) => {
        const raw = typeof entry.toObject === 'function' ? entry.toObject() : entry;
        const normalizedDetails = normalizeStoredResultDetails(raw?.details);
        const isLocked = hasResultLimit && index >= resultViewLimit;
        if (!isLocked) {
          return {
            ...raw,
            details: normalizedDetails,
            isLocked: false,
          };
        }

        return {
          ...raw,
          isLocked: true,
          details: {
            ...normalizedDetails,
            source: '',
            link: '',
          },
        };
      });

      const lockedCount = hasResultLimit ? Math.max(0, totalFound - resultViewLimit) : 0;

      // 7. Finalize
      searchRecord.status = 'completed';
      await searchRecord.save();
      await deductCredit(userId);

      return res.status(200).json({
        success: true,
        searchId: searchRecord._id,
        plan: plan.tier,
        totalFound,
        lockedCount,
        results: resultsForResponse,
      });
    } catch (searchError) {
      searchRecord.status = 'failed';
      await searchRecord.save();
      console.error('SerpApi Error:', searchError);
      return res.status(500).json({ error: 'Search engine processing failed' });
    }
  } catch (error: any) {
    console.error('System Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};