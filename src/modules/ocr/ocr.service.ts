import { visionClient } from '../../config/google-vision';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';

export class OcrService {
  
  async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      if (mimeType === 'application/pdf') {
        // --- PDF PROCESSING ---
        // Synchronously processes up to 5 pages from a buffer.
        const [result] = await visionClient.batchAnnotateFiles({
          requests: [
            {
              inputConfig: {
                mimeType: 'application/pdf',
                content: buffer,
              },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            },
          ],
        });

        // The response is an array of pages. We extract the text from each and join them.
        const responses = result.responses?.[0]?.responses || [];
        const extractedText = responses
          .map((res) => res.fullTextAnnotation?.text || '')
          .join('\n\n--- PAGE BREAK ---\n\n');

        if (!extractedText.trim()) {
          throw new AppError('No readable text found in this PDF.', StatusCodes.NOT_FOUND);
        }

        return extractedText;

      } else {
        // --- IMAGE PROCESSING ---
        // Standard document text detection for dense text in images.
        const [result] = await visionClient.documentTextDetection({
          image: { content: buffer },
        });

        const extractedText = result.fullTextAnnotation?.text || '';

        if (!extractedText.trim()) {
          throw new AppError('No readable text found in this image.', StatusCodes.NOT_FOUND);
        }

        return extractedText;
      }
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      
      throw new AppError(
        `Google Vision OCR Failed: ${error.message}`, 
        StatusCodes.INTERNAL_SERVER_ERROR
      );
    }
  }
}

export const ocrService = new OcrService();