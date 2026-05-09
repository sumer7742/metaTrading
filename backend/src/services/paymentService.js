/**
 * Payment Service.
 *
 * Provider-agnostic interface supporting Razorpay (India) and Stripe (international),
 * with a mock provider for dev. Used for:
 *   - Subscription billing (Premium/VIP plans)
 *   - Deposit funding (card payments to Live accounts)
 *
 * .env vars (set the ones you use):
 *   PAYMENT_PROVIDER=razorpay | stripe | mock   (default: mock)
 *   RAZORPAY_KEY_ID=...
 *   RAZORPAY_KEY_SECRET=...
 *   STRIPE_SECRET_KEY=sk_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *
 * Frontend flow:
 *   1. Client calls POST /api/subscriptions/subscribe with planCode
 *   2. Server creates payment order via createOrder()
 *   3. Server returns { orderId, amount, providerData } to client
 *   4. Client opens provider checkout (Razorpay/Stripe SDK)
 *   5. On payment success, provider webhook fires verifyPayment()
 *   6. Server activates the subscription
 *
 * For now, the mock provider auto-confirms — useful for end-to-end testing
 * without real card processing.
 */

let provider = 'mock';
let providerClient = null;

const init = () => {
  provider = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

  if (provider === 'razorpay') {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.warn('[Payment] PAYMENT_PROVIDER=razorpay but credentials missing - falling back to mock');
      provider = 'mock';
    } else {
      try {
        // eslint-disable-next-line global-require
        const Razorpay = require('razorpay');
        providerClient = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        console.log('[Payment] Razorpay configured');
      } catch (e) {
        console.warn('[Payment] razorpay package not installed (run: npm i razorpay). Falling back to mock.');
        provider = 'mock';
      }
    }
  } else if (provider === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.warn('[Payment] PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY missing - falling back to mock');
      provider = 'mock';
    } else {
      try {
        // eslint-disable-next-line global-require
        const Stripe = require('stripe');
        providerClient = new Stripe(process.env.STRIPE_SECRET_KEY);
        console.log('[Payment] Stripe configured');
      } catch (e) {
        console.warn('[Payment] stripe package not installed (run: npm i stripe). Falling back to mock.');
        provider = 'mock';
      }
    }
  }

  if (provider === 'mock') {
    console.log('[Payment] Mock mode active - all payments auto-succeed (dev only)');
  }
};

/**
 * Create a payment order for the given amount + currency.
 * Returns { orderId, amount, currency, providerData }
 */
const createOrder = async ({ amount, currency = 'INR', metadata = {} }) => {
  const amtMinor = Math.round(Number(amount) * 100); // razorpay/stripe use minor units
  if (provider === 'razorpay' && providerClient) {
    const order = await providerClient.orders.create({
      amount: amtMinor,
      currency,
      notes: metadata,
    });
    return {
      orderId: order.id,
      amount,
      currency,
      providerData: { keyId: process.env.RAZORPAY_KEY_ID, ...order },
    };
  }
  if (provider === 'stripe' && providerClient) {
    const intent = await providerClient.paymentIntents.create({
      amount: amtMinor,
      currency: currency.toLowerCase(),
      metadata,
    });
    return {
      orderId: intent.id,
      amount,
      currency,
      providerData: { clientSecret: intent.client_secret },
    };
  }
  // Mock: return a fake id and let client "confirm" it
  const fakeId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return { orderId: fakeId, amount, currency, providerData: { mock: true } };
};

/**
 * Verify a payment after the client says it succeeded (or webhook fires).
 * For Razorpay: verify signature using HMAC-SHA256.
 * For Stripe: webhook event with constructEvent.
 * For Mock: always returns true.
 *
 * Returns { ok, transactionId, amount, currency, raw }
 */
const verifyPayment = async ({ orderId, paymentId, signature, rawBody, signatureHeader }) => {
  if (provider === 'razorpay') {
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    if (expected !== signature) return { ok: false, reason: 'Invalid signature' };
    return { ok: true, transactionId: paymentId, raw: { orderId, paymentId } };
  }
  if (provider === 'stripe' && providerClient) {
    try {
      const event = providerClient.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
      if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        return {
          ok: true,
          transactionId: intent.id,
          amount: intent.amount / 100,
          currency: intent.currency.toUpperCase(),
          raw: event,
        };
      }
      return { ok: false, reason: `Event type ${event.type} not handled` };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  // Mock: auto-confirm
  return { ok: true, transactionId: orderId, raw: { mock: true } };
};

module.exports = { init, createOrder, verifyPayment, getProvider: () => provider };
