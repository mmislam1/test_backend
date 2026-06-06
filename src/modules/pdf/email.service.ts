import { sendEmail } from '../../common/helpers/email.client';

export const sendReportEmail = async (userEmail: string, pdfBuffer: Buffer) => {
  await sendEmail({
    fromName: 'Visual Search System',
    to: userEmail,
    subject: 'Your Image Search Results Report',
    text: 'Please find attached the PDF report containing your recent search results.',
    attachments: [
      {
        filename: 'Search_Results_Report.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
};