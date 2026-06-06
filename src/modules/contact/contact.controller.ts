import { Request, Response } from 'express';
import { isEmailServiceConfigured, sendEmail } from '../../common/helpers/email.client';

const CONTACT_RECIPIENT = process.env.CONTACT_RECIPIENT_EMAIL?.trim() || 'team.iphint@gmail.com';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeConsent = (value: unknown) => value === true;

export const submitContactInquiry = async (req: Request, res: Response) => {
  try {
    const fullName = normalizeText(req.body?.fullName);
    const companyName = normalizeText(req.body?.companyName);
    const workEmail = normalizeText(req.body?.workEmail).toLowerCase();
    const phoneNumber = normalizeText(req.body?.phoneNumber);
    const inquiryMessage = normalizeText(req.body?.inquiryMessage);

    const consentEmail = normalizeConsent(req.body?.consentEmail);
    const consentSms = normalizeConsent(req.body?.consentSms);
    const consentServiceUpdates = normalizeConsent(req.body?.consentServiceUpdates);
    const consentEventsPromotions = normalizeConsent(req.body?.consentEventsPromotions);

    if (!fullName || !workEmail || !inquiryMessage) {
      return res.status(400).json({
        success: false,
        message: 'Full Name, Work Email, and Inquiry Message are required.',
      });
    }

    if (!emailPattern.test(workEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid work email address.',
      });
    }

    if (!isEmailServiceConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Email service is not configured yet. Please try again later.',
      });
    }

    const consentSummary = [
      `Marketing email: ${consentEmail ? 'Yes' : 'No'}`,
      `SMS notifications: ${consentSms ? 'Yes' : 'No'}`,
      `Service updates: ${consentServiceUpdates ? 'Yes' : 'No'}`,
      `Events and promotions: ${consentEventsPromotions ? 'Yes' : 'No'}`,
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
        <h2 style="margin: 0 0 12px;">New Contact Inquiry</h2>
        <p><strong>Full Name:</strong> ${fullName}</p>
        <p><strong>Company Name:</strong> ${companyName || 'N/A'}</p>
        <p><strong>Work Email:</strong> ${workEmail}</p>
        <p><strong>Phone Number:</strong> ${phoneNumber || 'N/A'}</p>
        <p><strong>Inquiry Message:</strong></p>
        <pre style="white-space: pre-wrap; background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb;">${inquiryMessage}</pre>
        <p><strong>Consents:</strong></p>
        <pre style="white-space: pre-wrap; background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb;">${consentSummary}</pre>
      </div>
    `;

    await sendEmail({
      fromName: 'IPHINT Contact',
      to: CONTACT_RECIPIENT,
      replyTo: workEmail,
      subject: `New Contact Inquiry from ${fullName}`,
      text: [
        'New Contact Inquiry',
        `Full Name: ${fullName}`,
        `Company Name: ${companyName || 'N/A'}`,
        `Work Email: ${workEmail}`,
        `Phone Number: ${phoneNumber || 'N/A'}`,
        '',
        'Inquiry Message:',
        inquiryMessage,
        '',
        'Consents:',
        consentSummary,
      ].join('\n'),
      html,
    });

    return res.status(200).json({
      success: true,
      message: 'Inquiry submitted successfully.',
    });
  } catch (error) {
    console.error('[Contact] Failed to submit inquiry:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to submit inquiry right now. Please try again later.',
    });
  }
};
