import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { submitContactInquiry } from './contact.controller';

const router = Router();

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many contact submissions. Please try again later.',
  },
});

router.post('/', contactLimiter, submitContactInquiry);

export default router;
