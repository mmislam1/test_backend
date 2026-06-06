// modules/reports/reports.routes.ts
import { Router } from 'express';
import { handlePdfGeneration } from './reports.controller';
import { authMiddleware } from '../../common/middlewares/auth.middleware';

const router = Router();

// Endpoint: POST /api/v1/reports/generate
router.post('/generate', authMiddleware, handlePdfGeneration);

import { downloadReport, previewReport } from './reports.controller';
// GET /api/v1/pdf/download/:searchId  — triggers file download
router.get('/download/:searchId', authMiddleware, downloadReport);
// GET /api/v1/pdf/preview/:searchId   — opens inline in browser
router.get('/preview/:searchId', authMiddleware, previewReport);

export default router;