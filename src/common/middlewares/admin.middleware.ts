import { Request, Response, NextFunction } from 'express';
import { User } from '../../models/users';
import { AppError } from '../errors/AppError';
import { StatusCodes } from 'http-status-codes';

/**
 * Admin Middleware - Validates that the authenticated user has admin role
 * Must be used after authMiddleware
 */
export const isAdminMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Ensure authMiddleware has already set req.user
    if (!req.user?.id) {
      throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED);
    }

    // Fetch user to verify admin role
    const user = await User.findById(req.user.id);

    if (!user) {
      throw new AppError('User not found', StatusCodes.NOT_FOUND);
    }

    if (user.role !== 'admin') {
      throw new AppError(
        'Admin access required',
        StatusCodes.FORBIDDEN,
      );
    }

    // Attach admin user to request
    req.user = { id: user._id.toString(), isPro: true };
    next();
  } catch (error: any) {
    next(
      error instanceof AppError
        ? error
        : new AppError('Admin verification failed', StatusCodes.INTERNAL_SERVER_ERROR),
    );
  }
};
