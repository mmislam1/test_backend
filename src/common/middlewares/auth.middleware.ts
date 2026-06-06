import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError";
import { StatusCodes } from "http-status-codes";

// Extend Express Request interface to include user info
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; isPro: boolean };
    }
  }
}

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  
  const token = req.headers.authorization?.split(" ")[1]; // "Bearer <token>"

  if (!token) {
    return next(
      new AppError("Authentication required", StatusCodes.UNAUTHORIZED),
    );
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
    req.user = { id: decoded.id, isPro: decoded.isPro };
    next();
  } catch (error) {
    next(new AppError("Invalid or expired token", StatusCodes.UNAUTHORIZED));
  }
};
