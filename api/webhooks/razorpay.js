import { verifyRazorpaySignature, parseRazorpayEvent } from '../utils/webhookVerifier.js';
import { recordAndActivatePayment } from '../utils/cloudActivator.js';

/**
 * Razorpay Webhook Handler
 * Endpoint: /api/webhooks/razorpay
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Support both pre-parsed body and raw string body
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const verification = verifyRazorpaySignature({
      rawBody,
      signature,
      secret
    });

    if (!verification.valid) {
      console.warn('[RAZORPAY WEBHOOK] Signature verification failed:', verification.error);
      return res.status(400).json({ error: verification.error });
    }

    const parsed = parseRazorpayEvent(req.body);
    const result = await recordAndActivatePayment(parsed);

    return res.status(200).json({
      status: 'success',
      received: true,
      activation: result
    });
  } catch (err) {
    console.error('[RAZORPAY WEBHOOK ERROR]:', err);
    return res.status(500).json({ error: 'Internal server error processing Razorpay webhook' });
  }
}
