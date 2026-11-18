import crypto from 'node:crypto';

/**
 * Webhook Signature Verifier and Payload Parser for:
 * - Razorpay
 * - PhonePe
 * - Cashfree
 * - Stripe
 */

/**
 * Constant-time string equality check to prevent timing attacks
 */
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ==========================================
// 1. RAZORPAY VERIFICATION
// ==========================================
export function verifyRazorpaySignature({ rawBody, signature, secret }) {
  if (!secret) {
    // If no secret configured in test/dev mode, allow bypass with warning
    if (process.env.NODE_ENV === 'test' || !process.env.RAZORPAY_WEBHOOK_SECRET) {
      return { valid: true, testMode: true };
    }
    return { valid: false, error: 'Razorpay webhook secret not configured' };
  }
  if (!signature || !rawBody) {
    return { valid: false, error: 'Missing signature or payload body' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
    .digest('hex');

  const valid = secureCompare(signature, expectedSignature);
  return { valid, error: valid ? null : 'Invalid Razorpay signature' };
}

export function parseRazorpayEvent(payload) {
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const payment = event?.payload?.payment?.entity || event?.payload?.order?.entity || {};
  const notes = payment.notes || {};

  return {
    gateway: 'razorpay',
    eventId: event.id || payment.id,
    eventType: event.event || 'payment.captured',
    isSuccessful: event.event === 'payment.captured' || event.event === 'order.paid' || payment.status === 'captured',
    orderId: payment.order_id || notes.orderId || null,
    transactionId: payment.id || notes.transactionRef || `RZP_${Date.now()}`,
    amount: payment.amount ? Number(payment.amount) / 100 : (Number(notes.amount) || 0),
    currency: payment.currency || 'INR',
    customerName: notes.customerName || notes.clientCode || payment.email?.split('@')[0] || 'Studio Customer',
    customerEmail: payment.email || notes.customerEmail || notes.email || '',
    customerPhone: payment.contact || notes.phone || '',
    planTier: notes.planTier || notes.plan || 'pro',
    isLifetime: notes.planTier === 'enterprise' || notes.isLifetime === true,
    rawPayload: event
  };
}

// ==========================================
// 2. PHONEPE VERIFICATION
// ==========================================
export function verifyPhonePeSignature({ base64Response, xVerifyHeader, saltKey, saltIndex = '1' }) {
  if (!saltKey) {
    if (process.env.NODE_ENV === 'test' || !process.env.PHONEPE_SALT_KEY) {
      return { valid: true, testMode: true };
    }
    return { valid: false, error: 'PhonePe salt key not configured' };
  }
  if (!base64Response || !xVerifyHeader) {
    return { valid: false, error: 'Missing base64 response or X-VERIFY header' };
  }

  const dataToHash = `${base64Response}${saltKey}`;
  const computedHash = crypto.createHash('sha256').update(dataToHash).digest('hex');
  const expectedHeader = `${computedHash}###${saltIndex}`;

  const valid = secureCompare(xVerifyHeader, expectedHeader);
  return { valid, error: valid ? null : 'Invalid PhonePe X-VERIFY signature' };
}

export function parsePhonePeEvent(base64Response) {
  let decodedStr = '';
  if (typeof base64Response === 'string') {
    // If passed as raw JSON with a "response" field
    try {
      const parsed = JSON.parse(base64Response);
      if (parsed.response) {
        decodedStr = Buffer.from(parsed.response, 'base64').toString('utf8');
      } else {
        decodedStr = base64Response;
      }
    } catch {
      // Direct base64 string
      decodedStr = Buffer.from(base64Response, 'base64').toString('utf8');
    }
  } else if (base64Response?.response) {
    decodedStr = Buffer.from(base64Response.response, 'base64').toString('utf8');
  }

  const data = JSON.parse(decodedStr);
  const paymentData = data.data || {};
  const merchantTxnId = paymentData.merchantTransactionId || '';

  // Extract metadata encoded into merchantTxnId (e.g. BV_PRO_CUSTNAME_TIMESTAMP)
  let extractedPlan = 'pro';
  let extractedName = 'Studio Customer';
  if (merchantTxnId.startsWith('BV_')) {
    const parts = merchantTxnId.split('_');
    if (parts[1]) extractedPlan = parts[1].toLowerCase();
    if (parts[2]) extractedName = decodeURIComponent(parts[2]);
  }

  return {
    gateway: 'phonepe',
    eventId: paymentData.transactionId || merchantTxnId,
    eventType: data.code || 'PAYMENT_SUCCESS',
    isSuccessful: data.code === 'PAYMENT_SUCCESS' || paymentData.state === 'COMPLETED' || data.success === true,
    orderId: merchantTxnId,
    transactionId: paymentData.transactionId || merchantTxnId,
    amount: paymentData.amount ? Number(paymentData.amount) / 100 : 0,
    currency: 'INR',
    customerName: paymentData.customerName || extractedName,
    customerEmail: paymentData.customerEmail || '',
    customerPhone: paymentData.paymentInstrument?.phone || '',
    planTier: paymentData.planTier || extractedPlan,
    isLifetime: extractedPlan === 'enterprise',
    rawPayload: data
  };
}

// ==========================================
// 3. CASHFREE VERIFICATION
// ==========================================
export function verifyCashfreeSignature({ rawBody, signature, timestamp, secretKey }) {
  if (!secretKey) {
    if (process.env.NODE_ENV === 'test' || !process.env.CASHFREE_SECRET_KEY) {
      return { valid: true, testMode: true };
    }
    return { valid: false, error: 'Cashfree secret key not configured' };
  }
  if (!signature || !timestamp || !rawBody) {
    return { valid: false, error: 'Missing Cashfree signature, timestamp, or raw body' };
  }

  // Reject webhooks older than 5 minutes to prevent replay attacks
  const reqTime = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - reqTime) > 300) {
    return { valid: false, error: 'Cashfree webhook timestamp expired' };
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signatureData = `${timestamp}${bodyStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(signatureData)
    .digest('base64');

  const valid = secureCompare(signature, expectedSignature);
  return { valid, error: valid ? null : 'Invalid Cashfree signature' };
}

export function parseCashfreeEvent(payload) {
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const order = event?.data?.order || {};
  const payment = event?.data?.payment || {};
  const customer = event?.data?.customer_details || {};
  const tags = order.order_tags || {};

  return {
    gateway: 'cashfree',
    eventId: payment.cf_payment_id || order.order_id,
    eventType: event.type || 'PAYMENT_SUCCESS_WEBHOOK',
    isSuccessful: payment.payment_status === 'SUCCESS' || event.type === 'PAYMENT_SUCCESS_WEBHOOK',
    orderId: order.order_id,
    transactionId: String(payment.cf_payment_id || order.order_id),
    amount: Number(order.order_amount || payment.payment_amount || 0),
    currency: order.order_currency || 'INR',
    customerName: customer.customer_name || tags.customerName || 'Studio Customer',
    customerEmail: customer.customer_email || tags.customerEmail || '',
    customerPhone: customer.customer_phone || tags.customerPhone || '',
    planTier: tags.planTier || 'pro',
    isLifetime: tags.planTier === 'enterprise',
    rawPayload: event
  };
}

// ==========================================
// 4. STRIPE VERIFICATION
// ==========================================
export function verifyStripeSignature({ rawBody, signatureHeader, endpointSecret, toleranceSeconds = 300 }) {
  if (!endpointSecret) {
    if (process.env.NODE_ENV === 'test' || !process.env.STRIPE_WEBHOOK_SECRET) {
      return { valid: true, testMode: true };
    }
    return { valid: false, error: 'Stripe webhook secret not configured' };
  }
  if (!signatureHeader || !rawBody) {
    return { valid: false, error: 'Missing Stripe signature header or body' };
  }

  const items = signatureHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = items.t;
  const signature = items.v1;

  if (!timestamp || !signature) {
    return { valid: false, error: 'Invalid Stripe signature format' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
    return { valid: false, error: 'Stripe webhook timestamp expired' };
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${timestamp}.${bodyStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', endpointSecret)
    .update(signedPayload)
    .digest('hex');

  const valid = secureCompare(signature, expectedSignature);
  return { valid, error: valid ? null : 'Invalid Stripe v1 signature' };
}

export function parseStripeEvent(payload) {
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const obj = event?.data?.object || {};
  const metadata = obj.metadata || {};
  const customerDetails = obj.customer_details || {};

  return {
    gateway: 'stripe',
    eventId: event.id || obj.id,
    eventType: event.type || 'checkout.session.completed',
    isSuccessful: event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded' || obj.status === 'complete' || obj.status === 'succeeded',
    orderId: obj.id,
    transactionId: obj.payment_intent || obj.id,
    amount: obj.amount_total ? Number(obj.amount_total) / 100 : (obj.amount ? Number(obj.amount) / 100 : 0),
    currency: (obj.currency || 'INR').toUpperCase(),
    customerName: metadata.customerName || customerDetails.name || 'Studio Customer',
    customerEmail: customerDetails.email || obj.customer_email || metadata.customerEmail || '',
    customerPhone: customerDetails.phone || '',
    planTier: metadata.planTier || 'pro',
    isLifetime: metadata.planTier === 'enterprise',
    rawPayload: event
  };
}
