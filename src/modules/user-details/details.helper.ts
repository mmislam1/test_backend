import { Result } from '../../models/results';

export const getSearchDetails = async (search: any) => {
  const resultCount = await Result.countDocuments({ searchId: search._id });
  
  // Extracting file name from Cloudinary/URL if possible
  const fileName = search.image.split('/').pop() || 'unknown_file';

  return {
    searchId: search._id,
    image: search.image,
    status: search.status,
    time: search.date,
    resultCount,
    fileName
  };
};