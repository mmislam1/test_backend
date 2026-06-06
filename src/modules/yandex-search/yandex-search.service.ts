import axios from 'axios';
import FormData from 'form-data';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';
import { User, Search, Result } from '../../models';

const { YANDEX_API_URL, YANDEX_API_KEY } = process.env;

export class YandexSearchService {
  async searchAndSave(imageBuffer: Buffer, userId: string) {
    let matches: any[] = [];
    let status: 'completed' | 'failed' | 'reviewPending' = 'completed';

    // 1. Create the Search Record
    const searchRecord = await Search.create({
      image: 'uploaded_buffer', // In production, replace with S3/Cloudinary URL
      status: 'processing',
      userId,
    });

    try {
      // 2. Call Yandex API
      const formData = new FormData();
      formData.append('image', imageBuffer, { filename: 'search.jpg' });

      const response = await axios.post(YANDEX_API_URL as string, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
        },
      });

      // Parse matches
      matches = response.data?.items?.map((item: any) => ({
        url: item.url,
        title: item.title,
        domain: item.domain,
      })) || [];

      if (matches.length === 0) status = 'reviewPending';

      // 3. Save the Results Record
      await Result.create({
        searchId: searchRecord._id,
        image: 'uploaded_buffer',
        details: { matches, source: 'Yandex' },
      });

      // 4. Deduct 1 Credit
      await User.findByIdAndUpdate(userId, { $inc: { credits: -1 } });

    } catch (error: any) {
      status = 'failed';
      await Search.findByIdAndUpdate(searchRecord._id, { status });
      throw new AppError('Yandex Search Failed', StatusCodes.BAD_GATEWAY);
    }

    // 5. Update Search Status
    await Search.findByIdAndUpdate(searchRecord._id, { status });

    return matches;
  }
}

export const yandexSearchService = new YandexSearchService();