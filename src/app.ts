import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { imageSearchRouter } from "./modules/image-search/image-search.routes";
import { AppError } from "./common/errors/AppError";
import { StatusCodes } from "http-status-codes";
import { authRouter } from "./routes/auth.routes";
import { yandexSearchRouter } from "./modules/image-search-2/yandex.routes";
import { rewardsRouter } from './modules/rewards/rewards.routes';
import { yandexRouter } from './modules/yandex-search2/yandex.routes';
import searchRoutes from './modules/image-serp/searchRoutes';
import pdfRoutes from './modules/pdf/reports.routes';
import userDetails from './modules/user-details/user-details.routes';
import billingRoutes from './modules/xxbilling/xxbilling.routes';
import referralRoutes from './modules/referral/referral.routes';
import { adminRouter } from './modules/admin/admin.routes';
import contactRoutes from './modules/contact/contact.routes';
import rateLimit from 'express-rate-limit';
import { handleXXPaddleWebhook } from "./modules/xxbilling/xxpaddle.webhook";
import passport from './config/passport';

const app = express();

// Render/Cloud reverse proxy support for accurate req.ip (rate limiting)
app.set('trust proxy', 1);

app.post(
	'/api/v1/webhooks/paddle',
	express.raw({ type: 'application/json' }),
	(req, _res, next) => {
		const body = req.body;
		(req as any).rawBody = Buffer.isBuffer(body)
			? body.toString('utf8')
			: typeof body === 'string'
				? body
				: '';
		next();
	},
	handleXXPaddleWebhook,
);

app.get('/api/v1/webhooks/paddle', (_req, res) => {
	res.status(405).json({
		success: false,
		message: 'Use POST for Paddle webhooks.',
	});
});

app.get('/', (_req, res) => {
	res.json({ success: true, message: 'IPHINT backend is healthy.' });
});

// 1. Security & Utility Middlewares
app.use(helmet());

const normalizeOrigin = (value: string) => {
	try {
		const u = new URL(value.trim());
		return `${u.protocol}//${u.host}`.toLowerCase();
	} catch {
		return value.trim().replace(/\/+$/g, '').toLowerCase();
	}
};

const allowedOrigins = Array.from(
	new Set(
		[
			...(process.env.ALLOWED_ORIGINS ?? '').split(','),
			process.env.FRONTEND_URL ?? '',
		]
			.map((o) => normalizeOrigin(o))
			.filter(Boolean),
	),
);

if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
	throw new Error('ALLOWED_ORIGINS must be set in production.');
}

app.use(
  cors({
    origin: (origin, callback) => {
      // allow server-to-server / curl (no origin header)
      if (!origin) return callback(null, true);
			const normalizedOrigin = normalizeOrigin(origin);
			if (allowedOrigins.length === 0 || allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    },
    credentials: true,
  }),
);

app.use(morgan("dev"));
app.use(express.json());
app.use(passport.initialize());

// 2. Feature Routes
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 20,
	message: { success: false, message: 'Too many requests, please try again later.' },
	standardHeaders: true,
	legacyHeaders: false,
});

app.use("/api/v1/image-search", imageSearchRouter);
app.use("/api/v1/auth", authLimiter, authRouter);
app.use('/auth', authLimiter, authRouter);
app.use('/api/v1/image-search-2', yandexSearchRouter);
app.use('/api/v1/rewards', rewardsRouter);
app.use('/api/v1/yandex', yandexRouter);
app.use('/api/v1/serp', searchRoutes);
app.use('/api/v1/pdf', pdfRoutes);
app.use('/api/v1/user-details', userDetails);
app.use('/api/v1/user', userDetails);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/referral', referralRoutes);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/contact', contactRoutes);

// 3. 404 Handler
app.use((req, res, next) => {
	next(
		new AppError(`Route ${req.originalUrl} not found`, StatusCodes.NOT_FOUND),
	);
});

// 4. Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
	const statusCode = err.statusCode || 500;
	const message = err.message || "Internal Server Error";

	console.error(`[Error] ${message}`);

	res.status(statusCode).json({
		success: false,
		error: {
			message,
			...(process.env.NODE_ENV === "development" && { stack: err.stack }),
		},
	});
});

export default app;
