import { visionClient } from "../../config/google-vision";
import { AppError } from "../../common/errors/AppError";
import { StatusCodes } from "http-status-codes";
import type { XXPlanTier as PlanTier } from "../../models/xxplan";

export class ImageSearchService {
  async detectExactMatches(imageBuffer: Buffer, planTier: PlanTier): Promise<any> {
    try {
      const [result] = await visionClient.webDetection({
        image: { content: imageBuffer },
      });

      const webDetection = result.webDetection;
      if (!webDetection)
        throw new AppError("No results", StatusCodes.BAD_GATEWAY);

      const exactMatches = webDetection.fullMatchingImages || [];
      const pages = webDetection.pagesWithMatchingImages || [];
      const partialMatchingImages = webDetection.partialMatchingImages || [];

      // starter = limited teaser; pro / premium = full results
      const isFullAccess = planTier === 'pro' || planTier === 'premium';

      if (isFullAccess) {
        return {
          planTier,
          exactMatches: exactMatches.map((img) => ({ url: img.url, score: img.score })),
          partialMatchingImages,
          pages: pages.map((page) => ({ title: page.pageTitle, url: page.url })),
        };
      }

      // Starter / credits: return counts + first match as preview only
      return {
        planTier,
        message: 'Upgrade to Pro or Premium to see all URLs and source pages.',
        matchCount: exactMatches.length,
        previewMatch: exactMatches.length > 0 ? exactMatches[0].url : null,
        pagesFound: pages.length,
      };
    } catch (error: any) {
      throw new AppError(
        `Vision API Failed: ${error.message}`,
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
export const imageSearchService = new ImageSearchService();
