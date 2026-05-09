const nodemailer = require('nodemailer');

/**
 * Email service. Uses SMTP credentials from .env if configured,
 * otherwise logs emails to the console in dev so flows can be tested
 * without external dependencies.
 *
 * To wire a real provider in production, point SMTP_* env vars at
 * SendGrid / SES / Mailgun / your SMTP host.
 */

let transporter = null;
let mode = 'console'; // 'smtp' | 'console'

const initEmail = () => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    mode = 'smtp';
    console.log('[Email] SMTP transport configured:', process.env.SMTP_HOST);
  } else {
    mode = 'console';
    console.log('[Email] No SMTP credentials - emails will be logged to console');
  }
};

const send = async ({ to, subject, html, text }) => {
  const from = process.env.EMAIL_FROM || 'no-reply@tradingplatform.local';
  if (mode === 'smtp' && transporter) {
    try {
      await transporter.sendMail({ from, to, subject, html, text: text || stripHtml(html) });
      console.log(`[Email] Sent: "${subject}" -> ${to}`);
    } catch (e) {
      console.error('[Email] SMTP send failed:', e.message);
    }
  } else {
    console.log('\n========== EMAIL (console mode) ==========');
    console.log(`To:      ${to}`);
    console.log(`From:    ${from}`);
    console.log(`Subject: ${subject}`);
    console.log('---');
    console.log(text || stripHtml(html));
    console.log('==========================================\n');
  }
};

const stripHtml = (html = '') => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// =============== Templates ===============
const tpl = (title, body) => `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e13;font-family:Segoe UI,Roboto,sans-serif;color:#e5e7eb;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="background:#121821;border:1px solid #222a36;border-radius:12px;padding:32px;">
      <div style="display:flex;align-items:center;margin-bottom:24px;">
        <span style="display:inline-block;width:32px;height:32px;background:#2dd4bf;color:#0a0e13;border-radius:6px;text-align:center;line-height:32px;font-weight:bold;margin-right:10px;">▲</span>
        <span style="font-size:18px;font-weight:bold;color:#fff;">TradePro</span>
      </div>
      <h1 style="font-size:22px;color:#fff;margin:0 0 16px;">${title}</h1>
      <div style="font-size:14px;line-height:1.6;color:#d1d5db;">${body}</div>
      <p style="font-size:12px;color:#6b7280;margin-top:32px;border-top:1px solid #222a36;padding-top:16px;">
        TradePro &middot; This is an automated message. Please do not reply.
      </p>
    </div>
  </div>
</body></html>
`;

const sendWelcome = ({ to, firstName }) =>
  send({
    to,
    subject: 'Welcome to TradePro',
    html: tpl(
      `Welcome${firstName ? ', ' + firstName : ''}!`,
      `<p>Your account is ready. We've set up a Demo account with $10,000 of virtual funds and an empty Live account.</p>
       <p>To start trading on the Live account, complete KYC verification first.</p>`
    ),
  });

const sendPasswordReset = ({ to, resetToken, baseUrl }) => {
  const link = `${baseUrl || 'http://localhost:5173'}/reset-password?token=${resetToken}`;
  return send({
    to,
    subject: 'Password reset request',
    html: tpl(
      'Reset your password',
      `<p>We received a request to reset your password. Click the link below within 30 minutes:</p>
       <p><a href="${link}" style="background:#2dd4bf;color:#0a0e13;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Reset Password</a></p>
       <p style="font-size:12px;color:#9ca3af;">If you didn't request this, ignore this email — your password won't change.</p>`
    ),
  });
};

const sendWithdrawalAlert = ({ to, amount, currency, status, destination }) =>
  send({
    to,
    subject: `Withdrawal ${status.toLowerCase()}: ${amount} ${currency}`,
    html: tpl(
      `Withdrawal ${status}`,
      `<p>Your withdrawal of <b>${amount} ${currency}</b> has been <b>${status}</b>.</p>
       <p>Destination: <code>${destination || 'n/a'}</code></p>
       <p>If you didn't authorize this, contact support immediately.</p>`
    ),
  });

const sendMarginCallAlert = ({ to, accountNumber, marginLevel }) =>
  send({
    to,
    subject: `⚠️ Margin call on ${accountNumber}`,
    html: tpl(
      'Margin Call',
      `<p>Account <b>${accountNumber}</b> margin level has dropped to <b>${Number(marginLevel).toFixed(1)}%</b>.</p>
       <p>Add funds or close positions immediately to avoid stop-out (occurs at 50%).</p>`
    ),
  });

const sendKycReviewed = ({ to, decision, reason }) =>
  send({
    to,
    subject: `KYC ${decision === 'APPROVED' ? 'approved' : 'rejected'}`,
    html: tpl(
      `KYC ${decision === 'APPROVED' ? 'Approved' : 'Rejected'}`,
      decision === 'APPROVED'
        ? `<p>Congratulations! Your KYC verification has been approved. You can now trade on your Live account.</p>`
        : `<p>Your KYC submission was rejected.</p><p>Reason: <i>${reason || 'Documents insufficient'}</i></p><p>Please re-submit with valid documents.</p>`
    ),
  });

const sendLoginAlert = ({ to, ip, userAgent }) =>
  send({
    to,
    subject: 'New login to your account',
    html: tpl(
      'New login detected',
      `<p>Your account was accessed from a new device:</p>
       <ul><li>IP: ${ip}</li><li>Device: ${userAgent}</li></ul>
       <p>If this wasn't you, change your password and revoke active sessions in the Profile page.</p>`
    ),
  });

const sendVerifyEmail = ({ to, token, baseUrl }) => {
  const link = `${baseUrl || 'http://localhost:5173'}/verify-email?token=${token}`;
  return send({
    to,
    subject: 'Verify your email address',
    html: tpl(
      'Verify your email',
      `<p>Welcome to TradePro! Click below to verify your email address:</p>
       <p><a href="${link}" style="background:#2dd4bf;color:#0a0e13;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Verify Email</a></p>
       <p style="font-size:12px;color:#9ca3af;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>`
    ),
  });
};

const sendPriceAlert = ({ to, symbol, direction, targetPrice, currentPrice }) =>
  send({
    to,
    subject: `Price alert: ${symbol} ${direction.toLowerCase()} ${targetPrice}`,
    html: tpl(
      'Price alert triggered',
      `<p><b>${symbol}</b> is now <b>${direction.toLowerCase()} ${targetPrice}</b>.</p>
       <p>Current price: <b>${currentPrice}</b></p>
       <p><a href="http://localhost:5173/trade?symbol=${symbol}" style="color:#2dd4bf;">Open chart</a></p>`
    ),
  });

const sendBackupCodes = ({ to, codes }) =>
  send({
    to,
    subject: '2FA backup codes',
    html: tpl(
      'Save these backup codes',
      `<p>Use these codes if you lose access to your authenticator app. Each code can be used once.</p>
       <pre style="background:#0a0e13;padding:16px;border-radius:6px;font-family:monospace;color:#2dd4bf;font-size:14px;line-height:1.8;">${codes.join('\n')}</pre>
       <p style="font-size:12px;color:#9ca3af;">Store these somewhere safe (password manager, printed copy). They will not be shown again.</p>`
    ),
  });

module.exports = {
  initEmail,
  send,
  sendWelcome,
  sendPasswordReset,
  sendWithdrawalAlert,
  sendMarginCallAlert,
  sendKycReviewed,
  sendLoginAlert,
  sendVerifyEmail,
  sendPriceAlert,
  sendBackupCodes,
};
