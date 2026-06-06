import axios from 'axios';
import FormData from 'form-data';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';
import { YandexQuery, IYandexMatch } from './yandex.model';

const { YANDEX_API_URL, YANDEX_API_KEY } = process.env;

export class YandexSearchService {
  
  async searchAndSave(imageBuffer: Buffer, fileName: string, userId: string) {
    let matches: IYandexMatch[] = [];
    let status: 'SUCCESS' | 'NO_RESULTS' | 'FAILED' = 'SUCCESS';
    let reviewPending = false;
    let errorMessage = '';

    try {
      // 1. Prepare Multipart Form Data for Yandex API
      const formData = new FormData();
      formData.append('image', imageBuffer, { filename: fileName || 'image.jpg' });

      // 2. Call Yandex API (Adjust headers based on your specific Yandex v2 spec)
      const response = await axios.post(YANDEX_API_URL as string, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
        },
      });

      // 3. Parse Results (Adjust based on actual Yandex JSON response structure)
      // Assuming Yandex returns: { data: { items: [ { url, title, domain } ] } }
      const items = response.data?.items || [];
      
      matches = items.map((item: any) => ({
        url: item.url,
        title: item.title,
        domain: item.domain,
      }));

      // 4. Logic: If no results, flag for review
      if (matches.length === 0) {
        status = 'NO_RESULTS';
        reviewPending = true; // <--- The requirement
      }

    } catch (error: any) {
      status = 'FAILED';
      reviewPending = true; // Flag failures for review as well
      errorMessage = error.message;
      console.error('Yandex API Error:', error?.response?.data || error.message);
      
      // We don't throw here immediately because we want to SAVE the failed state to DB first
    }

    // 5. Save the Query to MongoDB
    const savedQuery = await YandexQuery.create({
      userId,
      status,
      reviewPending,
      results: matches,
      errorMessage: errorMessage || undefined,
    });

    // 6. If it failed at the API level, throw error to controller AFTER saving
    if (status === 'FAILED') {
      throw new AppError('Yandex Search API failed to process the image.', StatusCodes.BAD_GATEWAY);
    }

    // 7. Return clean data to the controller
    return {
      queryId: savedQuery._id,
      status: savedQuery.status,
      reviewPending: savedQuery.reviewPending,
      matchCount: matches.length,
      matches,
    };
  }
}

export const yandexSearchService = new YandexSearchService();