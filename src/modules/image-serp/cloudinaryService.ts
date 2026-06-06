// services/cloudinaryService.ts
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadImageToCloudinary = async (
  imageBuffer: Buffer,
  originalFileName?: string,
): Promise<string> => {
  const uploadOptions: Record<string, unknown> = {
    folder: 'search_queries',
  };

  if (originalFileName) {
    // Keep the uploaded filename when Cloudinary stores the asset.
    uploadOptions.use_filename = true;
    uploadOptions.unique_filename = false;
    uploadOptions.overwrite = true;
    uploadOptions.filename_override = originalFileName;
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) return reject(error);
        if (result) return resolve(result.secure_url);
        reject(new Error('Unknown Cloudinary upload error'));
      }
    );
    uploadStream.end(imageBuffer);
  });
};