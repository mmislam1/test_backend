import multer from "multer";
import { AppError } from "../errors/AppError";
import { StatusCodes } from "http-status-codes";

const storage = multer.memoryStorage();

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(
        new AppError("Only image files are allowed!", StatusCodes.BAD_REQUEST),
      );
    }
  },
});
