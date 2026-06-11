import { Router } from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../common/middlewares/auth.middleware';
import { authController } from '../controllers/auth.controller';
import type { IUser } from '../models/users';
import { ensureXxProTrialOnSignin } from '../modules/xxbilling/xxbilling.service';

const router = Router();

const formatRetryWindow = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a few minutes';
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    const resetAt = (req as any).rateLimit?.resetTime;
    const retrySeconds = resetAt ? Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000)) : 0;
    const retryIn = formatRetryWindow(retrySeconds);

    res.status(429).json({
      success: false,
      message: `Too many login attempts. Please try again in ${retryIn}.`,
      code: 'LOGIN_RATE_LIMITED',
      retryAfterSeconds: retrySeconds,
    });
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset attempts. Please try again later.' },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset submissions. Please try again later.' },
});

const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification email requests. Please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many signup attempts. Please try again later.' },
});

/**
 * @route   POST /api/auth/register
 * @desc    Start email signup and send verification mail (optional referral from signup URL)
 * @access  Public
 */
router.post('/register', registerLimiter, authController.register);

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user and get token
 * @access  Public
 */
router.post('/login', loginLimiter, authController.login);
router.get('/me', authMiddleware, authController.me);
router.get('/verify-email', authController.verifyEmail);
router.post('/resend-verification', resendVerificationLimiter, authController.resendVerification);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password', resetPasswordLimiter, authController.resetPassword);

/**
 * @route   GET /api/auth/google
 * @desc    Redirect to Google OAuth consent screen (login only — no signup)
 * @access  Public
 */
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback — issues JWT and redirects to frontend
 * @access  Public
 */
router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const user = req.user as unknown as IUser;
      await ensureXxProTrialOnSignin(String(user._id));
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, {
        expiresIn: (process.env.JWT_EXPIRES_IN || '30d') as any,
      });
      const redirectUrl = `${process.env.FRONTEND_URL}/auth/google/success?token=${token}`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('[Auth] Google callback xx trial failed:', error);
      res.redirect(`${process.env.FRONTEND_URL}/login?error=google_auth_failed`);
    }
  },
);

export const authRouter = router;
