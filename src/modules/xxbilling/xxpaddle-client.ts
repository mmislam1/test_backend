import axios from 'axios';
import { safeXxSerialize } from './xxbilling.utils';

const xxPaddleBase = (): string =>
  process.env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

export const xxPaddleRequest = async <T = any>(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> => {
  const apiKey = process.env.XX_PADDLE_API_KEY?.trim() || process.env.PADDLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Paddle API key not configured. Set XX_PADDLE_API_KEY or PADDLE_API_KEY.');
  }

  console.log(`[XX Paddle API] ${method.toUpperCase()} ${path} | request=${safeXxSerialize(body ?? null)}`);

  try {
    const response = await axios({
      method,
      url: `${xxPaddleBase()}${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[XX Paddle API] ${method.toUpperCase()} ${path} | response=${safeXxSerialize({
      status: response.status,
      id: response.data?.data?.id ?? null,
    })}`);

    return response.data as T;
  } catch (error: any) {
    console.error(`[XX Paddle API] ${method.toUpperCase()} ${path} | error=${safeXxSerialize({
      status: error?.response?.status ?? null,
      message: error?.message,
      paddleError: error?.response?.data?.error ?? null,
    })}`);
    throw error;
  }
};
