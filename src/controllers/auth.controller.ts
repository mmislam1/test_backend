import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import { User } from '../models/users';
import { PendingRegistration } from '../models/pending-registrations';
import { ReferralEvent } from '../models/referral-event';
import { AppError } from '../common/errors/AppError';
import { isEmailServiceConfigured, sendEmail } from '../common/helpers/email.client';
import {
  completeReferralEvent,
  grantFreeMonthPremium,
} from '../modules/referral/referral.controller';
import { ensureXxProTrialOnSignin } from '../modules/xxbilling/xxbilling.service';

const signToken = (id: string) => {
  const options: SignOptions = {
    expiresIn: (process.env.JWT_EXPIRES_IN || '30d') as SignOptions['expiresIn'],
  };
  return jwt.sign({ id }, process.env.JWT_SECRET as string, options);
};

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isStrongPassword = (password: string) => {
  if (password.length < 8 || password.length > 128) return false;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasLower && hasUpper && hasDigit && hasSpecial;
};

const isValidPhoneNumber = (phoneNumber: string) => /^[+]?[0-9\-()\s]{7,24}$/.test(phoneNumber);

const getFrontendBase = () =>
  (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/g, '');

const createEmailVerificationToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  return { rawToken, tokenHash, expiresAt };
};

const sendEmailVerificationLink = async (
  email: string,
  name: string,
  rawToken: string,
) => {
  if (!isEmailServiceConfigured()) {
    console.warn('[Auth] Resend email is not configured. Verification email was not sent.');
    return;
  }

  const verifyUrl = `${getFrontendBase()}/login?verifyToken=${encodeURIComponent(rawToken)}`;

  await sendEmail({
    fromName: 'IPHINT',
    to: email,
    subject: 'Verify your email address',
    text: `Hi ${name},\n\nPlease verify your email to activate your account and start your free trial:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
        <h2 style="margin-bottom: 12px;">Verify your email</h2>
        <p>Hi ${name}, please verify your email to activate your account and start your free trial.</p>
        <p>
          <a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">
            Verify email
          </a>
        </p>
        <p>This link expires in 24 hours.</p>
      </div>
    `,
  });
};

export class AuthController {
  register = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const referralCode = String(req.body?.referralCode || '').trim().toUpperCase();
      const companyName = String(req.body?.companyName || '').trim();
      const specificRole = String(req.body?.specificRole || '').trim();
      const country = String(req.body?.country || '').trim();
      const phoneNumber = String(req.body?.phoneNumber || '').trim();

      if (!name) {
        throw new AppError('Name is required', StatusCodes.BAD_REQUEST);
      }
      if (!companyName) {
        throw new AppError('Business environment is required.', StatusCodes.BAD_REQUEST);
      }
      if (!specificRole) {
        throw new AppError('Specific role is required.', StatusCodes.BAD_REQUEST);
      }
      if (!phoneNumber) {
        throw new AppError('Alert contact info is required.', StatusCodes.BAD_REQUEST);
      }
      if (!isValidPhoneNumber(phoneNumber)) {
        throw new AppError('Please provide a valid contact number.', StatusCodes.BAD_REQUEST);
      }
      if (!isValidEmail(email)) {
        throw new AppError('Please provide a valid email address.', StatusCodes.BAD_REQUEST);
      }
      if (!isStrongPassword(password)) {
        throw new AppError(
          'Password must be 8-128 chars and include uppercase, lowercase, number, and special character.',
          StatusCodes.BAD_REQUEST,
        );
      }

      const existingUser = await User.findOne({ email }).select('_id');
      if (existingUser) {
        throw new AppError('Email is already in use', StatusCodes.BAD_REQUEST);
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      let referrerId = null;
      let validReferral = false;
      if (referralCode) {
        const referrer = await User.findOne({ referralCode }).select('_id');
        if (referrer) {
          referrerId = referrer._id;
          validReferral = true;
        }
      }

      const verification = createEmailVerificationToken();

      await PendingRegistration.findOneAndUpdate(
        { email },
        {
          $set: {
            name,
            email,
            passwordHash,
            affiliation: companyName || undefined,
            jobTitle: specificRole || undefined,
            country: country || undefined,
            phoneNumber: phoneNumber || undefined,
            referredBy: referrerId,
            emailVerificationTokenHash: verification.tokenHash,
            emailVerificationExpiresAt: verification.expiresAt,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );

      await sendEmailVerificationLink(email, name, verification.rawToken);

      return res.status(StatusCodes.CREATED).json({
        success: true,
        referralApplied: validReferral,
        message:
          'Registration successful. Please verify your email to activate your account and use your trial.',
      });
    } catch (error) {
      next(error);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      const user = await User.findOne({ email });
      if (!user) {
        const pending = await PendingRegistration.findOne({
          email,
          emailVerificationExpiresAt: { $gt: new Date() },
        }).select('_id');

        if (pending) {
          throw new AppError(
            'Please verify your email before logging in. Check your inbox for the verification link.',
            StatusCodes.FORBIDDEN,
          );
        }

        throw new AppError('Invalid email or password', StatusCodes.UNAUTHORIZED);
      }

      if (!user.passwordHash) {
        throw new AppError('Invalid email or password', StatusCodes.UNAUTHORIZED);
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        throw new AppError('Invalid email or password', StatusCodes.UNAUTHORIZED);
      }

      if (!user.isActive) {
        throw new AppError('Account is disabled', StatusCodes.FORBIDDEN);
      }

      if (
        user.passwordHash &&
        user.emailVerified === false &&
        user.lastLoginAt &&
        !user.emailVerificationTokenHash &&
        !user.emailVerificationExpiresAt
      ) {
        user.emailVerified = true;
        await user.save();
      }

      if (user.passwordHash && user.emailVerified === false) {
        throw new AppError(
          'Please verify your email before logging in. Check your inbox for the verification link.',
          StatusCodes.FORBIDDEN,
        );
      }

      await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });
      const xxBilling = await ensureXxProTrialOnSignin(String(user._id));
      const refreshedUser = await User.findById(user._id)
        .select('credits alertsRemaining subscriptionStatus')
        .lean();

      const token = signToken(user._id as string);
      return res.status(StatusCodes.OK).json({
        success: true,
        token,
        data: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          credits: refreshedUser?.credits ?? user.credits,
          alertsRemaining: refreshedUser?.alertsRemaining ?? user.alertsRemaining,
          subscriptionStatus: refreshedUser?.subscriptionStatus ?? user.subscriptionStatus,
          referralCode: user.referralCode,
          referralCount: user.referralCount,
          xxBilling: xxBilling.subscription,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  me = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED);
      }

      const user = await User.findById(userId).select(
        '_id name email role credits referralCode referralCount isActive',
      );

      if (!user) {
        throw new AppError('User not found', StatusCodes.NOT_FOUND);
      }

      if (!user.isActive) {
        throw new AppError('Account is disabled', StatusCodes.FORBIDDEN);
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        data: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          credits: user.credits,
          referralCode: user.referralCode,
          referralCount: user.referralCount,
          emailVerified: user.emailVerified !== false,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email) {
        throw new AppError('Email is required.', StatusCodes.BAD_REQUEST);
      }
      if (!isValidEmail(email)) {
        throw new AppError('Please provide a valid email address.', StatusCodes.BAD_REQUEST);
      }

      const user = await User.findOne({ email });
      if (user && user.passwordHash) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

        user.passwordResetTokenHash = tokenHash;
        user.passwordResetExpiresAt = expiresAt;
        await user.save();

        const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(
          /\/+$/g,
          '',
        );
        const resetPath = (process.env.PASSWORD_RESET_PATH || '/reset-password').startsWith('/')
          ? process.env.PASSWORD_RESET_PATH || '/reset-password'
          : `/${process.env.PASSWORD_RESET_PATH || 'reset-password'}`;
        const resetUrl = `${frontendBase}${resetPath}?token=${encodeURIComponent(rawToken)}`;

        if (isEmailServiceConfigured()) {
          await sendEmail({
            fromName: 'IPHINT',
            to: user.email,
            subject: 'Reset your password',
            text: `You requested a password reset. Use this link within 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
            html: `
              <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
                <h2 style="margin-bottom: 12px;">Reset your password</h2>
                <p>We received a request to reset your password.</p>
                <p>
                  <a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:8px;">
                    Reset password
                  </a>
                </p>
                <p>This link expires in 30 minutes.</p>
                <p>If you did not request this, you can safely ignore this email.</p>
              </div>
            `,
          });
        } else {
          console.warn('[Auth] Resend email is not configured. Password reset email was not sent.');
        }
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        message: 'If an account exists with that email, a reset link has been sent.',
      });
    } catch (error) {
      next(error);
    }
  };

  resetPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = String(req.body?.token || '').trim();
      const password = String(req.body?.password || '');

      if (!token || !password) {
        throw new AppError('Token and password are required.', StatusCodes.BAD_REQUEST);
      }
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        throw new AppError('Invalid reset token format.', StatusCodes.BAD_REQUEST);
      }
      if (!isStrongPassword(password)) {
        throw new AppError(
          'Password must be 8-128 chars and include uppercase, lowercase, number, and special character.',
          StatusCodes.BAD_REQUEST,
        );
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const user = await User.findOne({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
      });

      if (!user) {
        throw new AppError('Invalid or expired reset token.', StatusCodes.BAD_REQUEST);
      }

      const salt = await bcrypt.genSalt(10);
      user.passwordHash = await bcrypt.hash(password, salt);
      user.passwordResetTokenHash = undefined;
      user.passwordResetExpiresAt = undefined;
      user.refreshTokenHash = undefined;
      await user.save();

      return res.status(StatusCodes.OK).json({
        success: true,
        message: 'Password has been reset successfully.',
      });
    } catch (error) {
      next(error);
    }
  };

  verifyEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = String(req.query?.token || req.body?.token || '').trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) {
        throw new AppError('Invalid or expired verification link.', StatusCodes.BAD_REQUEST);
      }

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // Backward compatibility for previously-created unverified user rows.
      const legacyUser = await User.findOne({
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: { $gt: new Date() },
      });

      if (legacyUser) {
        if (!legacyUser.emailVerified) {
          if (legacyUser.refferedBy) {
            await ReferralEvent.updateOne(
              { referredUserId: legacyUser._id },
              {
                $setOnInsert: {
                  referrerId: legacyUser.refferedBy,
                  referredUserId: legacyUser._id,
                  signedUpAt: new Date(),
                  isCompleted: false,
                },
              },
              { upsert: true },
            );
            await completeReferralEvent(String(legacyUser._id));
            await grantFreeMonthPremium(String(legacyUser._id));
          }

          legacyUser.emailVerified = true;
          legacyUser.emailVerificationTokenHash = undefined;
          legacyUser.emailVerificationExpiresAt = undefined;
          await legacyUser.save();
        }

        return res.status(StatusCodes.OK).json({
          success: true,
          message: 'Email verified successfully. You can now log in.',
        });
      }

      const pending = await PendingRegistration.findOne({
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: { $gt: new Date() },
      });

      if (!pending) {
        throw new AppError('Invalid or expired verification link.', StatusCodes.BAD_REQUEST);
      }

      const existingUser = await User.findOne({ email: pending.email }).select('_id');
      if (existingUser) {
        await PendingRegistration.deleteOne({ _id: pending._id });
        return res.status(StatusCodes.OK).json({
          success: true,
          message: 'Email verified successfully. You can now log in.',
        });
      }

      const newUser = await User.create({
        name: pending.name,
        email: pending.email,
        passwordHash: pending.passwordHash,
        affiliation: pending.affiliation,
        jobTitle: pending.jobTitle,
        country: pending.country,
        phoneNumber: pending.phoneNumber,
        refferedBy: pending.referredBy,
        emailVerified: true,
      });

      if (pending.referredBy) {
        await ReferralEvent.updateOne(
          { referredUserId: newUser._id },
          {
            $setOnInsert: {
              referrerId: pending.referredBy,
              referredUserId: newUser._id,
              signedUpAt: new Date(),
              isCompleted: false,
            },
          },
          { upsert: true },
        );
        await completeReferralEvent(String(newUser._id));
        await grantFreeMonthPremium(String(newUser._id));
      }

      await PendingRegistration.deleteOne({ _id: pending._id });

      return res.status(StatusCodes.OK).json({
        success: true,
        message: 'Email verified successfully. You can now log in.',
      });
    } catch (error) {
      next(error);
    }
  };

  resendVerification = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!isValidEmail(email)) {
        throw new AppError('Please provide a valid email address.', StatusCodes.BAD_REQUEST);
      }

      const user = await User.findOne({ email });
      if (user && !user.emailVerified) {
        const verification = createEmailVerificationToken();
        user.emailVerificationTokenHash = verification.tokenHash;
        user.emailVerificationExpiresAt = verification.expiresAt;
        await user.save();

        await sendEmailVerificationLink(user.email, user.name, verification.rawToken);

        return res.status(StatusCodes.OK).json({
          success: true,
          message: 'Verification email sent. Please check your inbox.',
        });
      }

      const pending = await PendingRegistration.findOne({ email });
      if (!pending) {
        return res.status(StatusCodes.OK).json({
          success: true,
          message: 'If this account needs verification, a new verification email has been sent.',
        });
      }

      const verification = createEmailVerificationToken();
      pending.emailVerificationTokenHash = verification.tokenHash;
      pending.emailVerificationExpiresAt = verification.expiresAt;
      await pending.save();

      await sendEmailVerificationLink(pending.email, pending.name, verification.rawToken);

      return res.status(StatusCodes.OK).json({
        success: true,
        message: 'Verification email sent. Please check your inbox.',
      });
    } catch (error) {
      next(error);
    }
  };
}

export const authController = new AuthController();
