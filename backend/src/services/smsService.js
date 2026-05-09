/**
 * SMS Service.
 *
 * Provider-agnostic interface. Wires to Twilio when TWILIO_* env vars are set,
 * otherwise logs to console for dev.
 *
 * .env vars (optional):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER  (e.g. "+15551234567")
 *
 * For Indian users, also consider MSG91 — same interface, swap the implementation.
 */

let provider = 'console';
let twilioClient = null;

const init = () => {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    try {
      // eslint-disable-next-line global-require
      const twilio = require('twilio');
      twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      provider = 'twilio';
      console.log('[SMS] Twilio configured');
    } catch (e) {
      console.warn('[SMS] Twilio package not installed (run: npm i twilio). Falling back to console mode.');
      provider = 'console';
    }
  } else {
    console.log('[SMS] No Twilio credentials - SMS messages will be logged to console');
  }
};

const send = async ({ to, body }) => {
  if (!to || !body) return;
  if (provider === 'twilio' && twilioClient) {
    try {
      await twilioClient.messages.create({ body, from: process.env.TWILIO_FROM_NUMBER, to });
      console.log(`[SMS] Sent to ${to}`);
    } catch (e) {
      console.error('[SMS] Twilio send failed:', e.message);
    }
  } else {
    console.log('\n========== SMS (console mode) ==========');
    console.log(`To:   ${to}`);
    console.log(`Body: ${body}`);
    console.log('========================================\n');
  }
};

const sendVerificationCode = ({ to, code }) =>
  send({ to, body: `Your TradePro verification code is: ${code}. Valid for 10 minutes.` });

const sendWithdrawalAlert = ({ to, amount, currency }) =>
  send({ to, body: `TradePro: Withdrawal of ${amount} ${currency} requested. If this wasn't you, contact support immediately.` });

const sendMarginCallAlert = ({ to, accountNumber, marginLevel }) =>
  send({ to, body: `TradePro ALERT: Account ${accountNumber} margin at ${Number(marginLevel).toFixed(1)}%. Add funds or close positions to avoid stop-out.` });

module.exports = { init, send, sendVerificationCode, sendWithdrawalAlert, sendMarginCallAlert };
