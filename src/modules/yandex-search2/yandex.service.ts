import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Search, Result } from '../../models';
import { AppError } from '../../common/errors/AppError';

export class YandexService {
  private cachedToken: string | null = null;
  private expiresAt: number = 0;

  /**
   * Automatically obtains a fresh IAM token using the Service Account Key
   */
  private async getIamToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.expiresAt > now + 60) return this.cachedToken;

    // Parse the JSON key stored in your .env
    const key = JSON.parse(process.env.YANDEX_SERVICE_ACCOUNT_JSON!);
    
    const tokenPayload = {
      iss: key.service_account_id,
      aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens',
      iat: now,
      exp: now + 3600,
    };

    const signedJwt = jwt.sign(tokenPayload, key.private_key, { 
      algorithm: 'PS256', 
      keyid: key.id 
    });

    const response = await axios.post('https://iam.api.cloud.yandex.net/iam/v1/tokens', {
      jwt: signedJwt,
    });

    this.cachedToken = response.data.iamToken;
    this.expiresAt = now + 3600;
    return this.cachedToken!;
  }

  async searchByImage(userId: string|undefined, imageData?: string, imageUrl?: string) {
    const token = await this.getIamToken();
    
    // Log search start
    const searchLog = await Search.create({
      image: imageUrl || 'file_upload',
      status: 'processing',
      userId
    });

    try {
      const response = await axios.post(
        "https://search-api.cloud.yandex.net/v2/imageSearch/searchByImage",
        {
          folderId: process.env.YANDEX_FOLDER_ID,
          ...(imageUrl ? { url: imageUrl } : { data: imageData }),
          familyMode: "FAMILY_MODE_MODERATE"
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Mapping Yandex v2 results
      const matches = response.data?.images?.map((img: any) => ({
        url: img.url,
        title: img.pageTitle,
        source: img.host,
        pageUrl: img.pageUrl
      })) || [];

      await Result.create({
        searchId: searchLog._id,
        image: imageUrl || 'file_upload',
        details: { matches }
      });

      await Search.findByIdAndUpdate(searchLog._id, { status: 'completed' });
      return matches;
    } catch (error: any) {
      await Search.findByIdAndUpdate(searchLog._id, { status: 'failed' });
      throw new AppError(`Yandex API Error: ${error.response?.data?.message || error.message}`, 502);
    }
  }
}

export const yandexService = new YandexService();