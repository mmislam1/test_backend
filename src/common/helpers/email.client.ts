import { Resend, type CreateEmailOptions } from 'resend';

type EmailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

type SendEmailInput = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

let resendClient: Resend | null = null;

const getResendApiKey = () => process.env.RESEND_API_KEY?.trim() || '';

const getFromAddress = () =>
  process.env.EMAIL_FROM?.trim() ||
  process.env.RESEND_FROM?.trim() ||
  process.env.SMTP_USER?.trim() ||
  '';

const buildFromHeader = (fromName?: string) => {
  const fromAddress = getFromAddress();
  if (!fromAddress) {
    return '';
  }

  return fromName ? `${fromName} <${fromAddress}>` : fromAddress;
};

const getClient = () => {
  const apiKey = getResendApiKey();
  if (!apiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
};

export const isEmailServiceConfigured = () => {
  return Boolean(getResendApiKey() && getFromAddress());
};

export const sendEmail = async ({
  to,
  subject,
  text,
  html,
  fromName,
  replyTo,
  attachments,
}: SendEmailInput) => {
  const client = getClient();
  const from = buildFromHeader(fromName);

  if (!client || !from) {
    throw new Error('Resend email service is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  }

  const preparedAttachments = attachments?.map((item) => ({
    filename: item.filename,
    content: Buffer.isBuffer(item.content) ? item.content.toString('base64') : item.content,
    ...(item.contentType ? { contentType: item.contentType } : {}),
  }));

  // Resend's CreateEmailOptions is a union; ensure one concrete branch by
  // always providing html OR text.
  const payload: CreateEmailOptions = {
    from,
    to,
    subject,
    ...(html ? { html } : { text: text ?? '' }),
    ...(replyTo ? { replyTo } : {}),
    ...(preparedAttachments?.length ? { attachments: preparedAttachments } : {}),
  };

  return client.emails.send(payload);
};
