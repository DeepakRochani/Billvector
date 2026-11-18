import { verifyStripeSignature, parseStripeEvent } from '../utils/webhookVerifier.js';
import { recordAndActivatePayment } from '../utils/cloudActivator.js';

/**
 * Stripe Webhook Handler
 * Endpoint: /api/webhooks/stripe
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const signatureHeader = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const verification = verifyStripeSignature({
      rawBody,
      signatureHeader,
      endpointSecret
    });

    if (!verification.valid) {
      console.warn('[STRIPE WEBHOOK] Signature verification failed:', verification.error);
      return res.status(400).json({ error: verification.error });
    }

    const parsed = parseStripeEvent(req.body);
    const result = await recordAndActivatePayment(parsed);

    return res.status(200).json({
      status: 'success',
      received: true,
      activation: result
    });
  } catch (err) {
    console.error('[STRIPE WEBHOOK ERROR]:', err);
    return res.status(500).json({ error: 'Internal server error processing Stripe webhook' });
  }
}
