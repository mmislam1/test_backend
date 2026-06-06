import vision from "@google-cloud/vision";

// The client automatically looks for GOOGLE_APPLICATION_CREDENTIALS env var
export const visionClient = new vision.ImageAnnotatorClient();
