import { verifyCashfreeSignature, parseCashfreeEvent } from '../utils/webhookVerifier.js';
import { recordAndActivatePayment } from '../utils/cloudActivator.js';

/**
 * Cashfree Webhook Handler
 * Endpoint: /api/webhooks/cashfree
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const secretKey = process.env.CASHFREE_SECRET_KEY;

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const verification = verifyCashfreeSignature({
      rawBody,
      signature,
      timestamp,
      secretKey
    });

    if (!verification.valid) {
      console.warn('[CASHFREE WEBHOOK] Signature verification failed:', verification.error);
      return res.status(400).json({ error: verification.error });
    }

    const parsed = parseCashfreeEvent(req.body);
    const result = await recordAndActivatePayment(parsed);

    return res.status(200).json({
      status: 'success',
      received: true,
      activation: result
    });
  } catch (err) {
    console.error('[CASHFREE WEBHOOK ERROR]:', err);
    return res.status(500).json({ error: 'Internal server error processing Cashfree webhook' });
  }
}
