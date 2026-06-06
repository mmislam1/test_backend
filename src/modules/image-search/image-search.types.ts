export interface ImageMatch {
  url: string;
  score?: number; // Confidence score if available
}

export interface PageMatch {
  title: string;
  url: string;
}

export interface VisionResult {
  exactMatches: ImageMatch[];
  pages: PageMatch[];
}
