import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { StatusCodes } from 'http-status-codes';

const storage = multer.memoryStorage();

export const ocrUploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit to accommodate small PDFs
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Only Images (JPG/PNG/WEBP) and PDFs are allowed for OCR.', StatusCodes.BAD_REQUEST));
    }
  },
});