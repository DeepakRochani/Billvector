import { verifyPhonePeSignature, parsePhonePeEvent } from '../utils/webhookVerifier.js';
import { recordAndActivatePayment } from '../utils/cloudActivator.js';

/**
 * PhonePe Server-to-Server Webhook Handler
 * Endpoint: /api/webhooks/phonepe
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const xVerify = req.headers['x-verify'];
    const saltKey = process.env.PHONEPE_SALT_KEY;
    const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';

    // PhonePe sends { response: "<base64>" }
    const base64Response = typeof req.body === 'object' ? req.body.response : req.body;

    const verification = verifyPhonePeSignature({
      base64Response,
      xVerifyHeader: xVerify,
      saltKey,
      saltIndex
    });

    if (!verification.valid) {
      console.warn('[PHONEPE WEBHOOK] Signature verification failed:', verification.error);
      return res.status(400).json({ error: verification.error });
    }

    const parsed = parsePhonePeEvent(base64Response);
    const result = await recordAndActivatePayment(parsed);

    return res.status(200).json({
      status: 'success',
      received: true,
      activation: result
    });
  } catch (err) {
    console.error('[PHONEPE WEBHOOK ERROR]:', err);
    return res.status(500).json({ error: 'Internal server error processing PhonePe webhook' });
  }
}
