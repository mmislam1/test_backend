// services/serpApiService.ts
import axios from 'axios';

export const executeReverseImageSearch = async (imageUrl: string) => {
  const params = {
    engine: "google_lens",
    url: imageUrl,
    api_key: process.env.SERPAPI_KEY,
    family_mode: "0",
  };

  const response = await axios.get('https://serpapi.com/search.json', { params });
  
  // Extracting visual matches. SerpApi Google Lens returns them in 'visual_matches'
  const matches = response.data.visual_matches || [];
  return matches;
};