import dotenv from "dotenv";
dotenv.config();

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key} in environment.`);
  }
  return value;
};

const requirePaddlePriceId = (key: string) => {
  const value = requireEnv(key);
  if (!/^pri_[a-z\d]{26}$/i.test(value)) {
    throw new Error(`Invalid ${key}. Expected a Paddle Price ID like pri_xxxxxxxxxxxxxxxxxxxxxxxxxx.`);
  }
  return value;
};

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS in .env");
}

if (process.env.NODE_ENV === 'production') {
  requireEnv('JWT_SECRET');
  requireEnv('FRONTEND_URL');
  requireEnv('GOOGLE_CALLBACK_URL');
  requireEnv('ALLOWED_ORIGINS');
  requireEnv('PADDLE_ENVIRONMENT');
  requireEnv('PADDLE_API_KEY');

  requirePaddlePriceId('PADDLE_STARTER_MONTHLY_PRICE_ID');
  requirePaddlePriceId('PADDLE_STARTER_ANNUAL_PRICE_ID');
  requirePaddlePriceId('PADDLE_PRO_MONTHLY_PRICE_ID');
  requirePaddlePriceId('PADDLE_PRO_ANNUAL_PRICE_ID');
  requirePaddlePriceId('PADDLE_PREMIUM_MONTHLY_PRICE_ID');
  requirePaddlePriceId('PADDLE_PREMIUM_ANNUAL_PRICE_ID');

  requireEnv('RESEND_API_KEY');
  requireEnv('EMAIL_FROM');
  requireEnv('ADMIN_NOTIFICATION_EMAIL');
}

export const config = {
  port: process.env.PORT || 5000,
  googleKeyPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
};
