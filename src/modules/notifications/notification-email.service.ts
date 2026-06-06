import { isEmailServiceConfigured, sendEmail } from '../../common/helpers/email.client';

const STATUS_LABELS: Record<string, string> = {
  takedown_request: 'Takedown Request',
  report_infringement: 'Report Infringement',
  dispute: 'Dispute',
  legal_support_request: 'Legal Support Request',
  not_reviewed: 'Not Reviewed',
  reviewed: 'Reviewed',
  rights_given: 'Rights Given',
  escalated: 'Escalated',
};

export const sendAdminResultStatusChangeEmail = async (payload: {
  userName: string;
  userEmail: string;
  resultId: string;
  searchId: string;
  matchImage: string;
  newStatus: string;
}) => {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!isEmailServiceConfigured()) {
    console.warn('[notification-email] Email service not configured (RESEND_API_KEY / EMAIL_FROM missing). Skipping admin status-change email.');
    return;
  }
  if (!adminEmail) {
    console.warn('[notification-email] ADMIN_NOTIFICATION_EMAIL is not set. Skipping admin status-change email.');
    return;
  }

  const statusLabel = STATUS_LABELS[payload.newStatus] ?? payload.newStatus;

  await sendEmail({
    fromName: 'IpHint System',
    to: adminEmail,
    subject: `Match Status Updated: ${statusLabel}`,
    text: [
      'Match Review Status Changed',
      `User: ${payload.userName} (${payload.userEmail})`,
      `New Status: ${statusLabel}`,
      `Result ID: ${payload.resultId}`,
      `Search ID: ${payload.searchId}`,
      `Match Image: ${payload.matchImage}`,
      'This is an automated notification from IpHint.',
    ].join('\n'),
    html: `
      <h2>Match Review Status Changed</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr><td><strong>User</strong></td><td>${payload.userName} (${payload.userEmail})</td></tr>
        <tr><td><strong>New Status</strong></td><td>${statusLabel}</td></tr>
        <tr><td><strong>Result ID</strong></td><td>${payload.resultId}</td></tr>
        <tr><td><strong>Search ID</strong></td><td>${payload.searchId}</td></tr>
        <tr><td><strong>Match Image</strong></td><td><a href="${payload.matchImage}">${payload.matchImage}</a></td></tr>
      </table>
      <p style="color:#888;font-size:12px;margin-top:16px;">This is an automated notification from IpHint.</p>
    `,
  });
};

export const sendWeeklyRescanNotificationEmail = async (
  userEmail: string,
  payload: { fileName: string; newMatchCount: number; searchId: string },
) => {
  if (!isEmailServiceConfigured()) {
    return;
  }

  await sendEmail({
    fromName: 'Visual Search System',
    to: userEmail,
    subject: `Weekly re-scan update: ${payload.newMatchCount} new match${payload.newMatchCount > 1 ? 'es' : ''}`,
    text: [
      `Your weekly re-scan for ${payload.fileName} found ${payload.newMatchCount} new match${payload.newMatchCount > 1 ? 'es' : ''}.`,
      `Open Monitoring to review: Search ID ${payload.searchId}`,
    ].join('\n'),
  });
};

export const sendAutoRenewOffReminderEmail = async (
  userEmail: string,
  payload: { daysLeft: number; cancelDate: Date; manageUrl?: string },
) => {
  if (!isEmailServiceConfigured()) {
    return;
  }

  const cancelDateText = payload.cancelDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  await sendEmail({
    fromName: 'Visual Search System',
    to: userEmail,
    subject: `Auto-renew is off: ${payload.daysLeft} day${payload.daysLeft !== 1 ? 's' : ''} left`,
    text: [
      `Your subscription is scheduled to end on ${cancelDateText}.`,
      `You currently have ${payload.daysLeft} day${payload.daysLeft !== 1 ? 's' : ''} left in this billing period.`,
      payload.manageUrl
        ? `To keep access uninterrupted, turn auto-renew back on: ${payload.manageUrl}`
        : 'To keep access uninterrupted, open your billing page and turn auto-renew back on.',
    ].join('\n'),
  });
};

export const sendTrialEndingReminderEmail = async (
  userEmail: string,
  payload: { daysLeft: number; trialEndDate: Date; manageUrl?: string },
) => {
  if (!isEmailServiceConfigured()) {
    return;
  }

  const trialEndDateText = payload.trialEndDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  await sendEmail({
    fromName: 'Visual Search System',
    to: userEmail,
    subject: `Your trial ends in ${payload.daysLeft} day${payload.daysLeft !== 1 ? 's' : ''}`,
    text: [
      `Your free trial will end on ${trialEndDateText}.`,
      `You have ${payload.daysLeft} day${payload.daysLeft !== 1 ? 's' : ''} left before access is limited.`,
      payload.manageUrl
        ? `Upgrade your plan here: ${payload.manageUrl}`
        : 'Upgrade your plan from your billing page to keep uninterrupted access.',
    ].join('\n'),
  });
};
