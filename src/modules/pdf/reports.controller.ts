// modules/reports/reports.controller.ts
import { Request, Response } from 'express';
import fs from 'fs';
import { Search } from '../../models/searches';
import { Result } from '../../models/results';
import { User } from '../../models/users';
import { XXSubscription } from '../../models/xxsubscription';
import { generateSearchPdf } from './reports.service';
import { sendReportEmail } from './email.service'; // Your existing email logic
import { getPlanDefinition, type PlanTier } from '../xxbilling/xxbilling.constants';
import { xxPickEffectiveSubscription } from '../xxbilling/xxbilling.service';

const getActivePlanTier = async (userId: string): Promise<PlanTier> => {
  const subscriptions = await XXSubscription.find({
    userId,
    status: { $in: ['active', 'trialing'] },
  })
    .sort({ activationDate: -1, createdAt: -1 })
    .lean();

  const activeSubscription = xxPickEffectiveSubscription(subscriptions as any[]);

  return (activeSubscription as any)?.planTier ?? 'starter';
};

export const handlePdfGeneration = async (req: Request, res: Response): Promise<any> => {
  try {
    const { searchId } = req.body; // Expecting searchId in JSON body
    const userId = req?.user?.id;

    if (!searchId) {
      return res.status(400).json({ success: false, message: 'searchId is required' });
    }

    const planTier = await getActivePlanTier(String(userId));
    const plan = getPlanDefinition(planTier);
    if (!plan.pdfEnabled) {
      return res.status(403).json({
        success: false,
        code: 'PDF_NOT_AVAILABLE_IN_PLAN',
        message: 'PDF reports are available on Pro and Premium plans. Please upgrade to continue.',
      });
    }

    // 1. Fetch search and results
    const searchData = await Search.findById(searchId);
    if (!searchData) {
      return res.status(404).json({ success: false, message: 'Search not found' });
    }

    const results = await Result.find({ searchId });
    const user = await User.findById(searchData.userId);

    if (!user || !user.email) {
      return res.status(404).json({ success: false, message: 'User email not found' });
    }

    // 2. Generate PDF and save to /pdf folder
    const { filePath } = await generateSearchPdf(searchData, results);

    // 3. Read the generated file into a Buffer and email it
    const pdfBuffer = fs.readFileSync(filePath);
    await sendReportEmail(user.email, pdfBuffer);

    return res.status(200).json({
      success: true,
      message: 'Report generated and emailed successfully',
      fileStoredAt: filePath
    });

  } catch (error: any) {
    console.error('PDF Module Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const streamReport = async (req: Request, res: Response, disposition: 'inline' | 'attachment'): Promise<any> => {
  try {
    const { searchId } = req.params;
    const userId = req?.user?.id;

    const planTier = await getActivePlanTier(String(userId));
    const plan = getPlanDefinition(planTier);
    if (!plan.pdfEnabled) {
      return res.status(403).json({
        success: false,
        code: 'PDF_NOT_AVAILABLE_IN_PLAN',
        message: 'PDF reports are available on Pro and Premium plans. Please upgrade to continue.',
      });
    }

    const searchData = await Search.findOne({ _id: searchId, userId });
    if (!searchData) {
      return res.status(404).json({ success: false, message: 'Search not found' });
    }

    const results = await Result.find({ searchId });
    const { filePath, fileName } = await generateSearchPdf(searchData, results);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(filePath, () => {}));
    stream.on('error', () => res.status(500).json({ success: false, message: 'Failed to stream PDF' }));
  } catch (error: any) {
    console.error('PDF Stream Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const downloadReport = (req: Request, res: Response) => streamReport(req, res, 'attachment');
export const previewReport  = (req: Request, res: Response) => streamReport(req, res, 'inline');
