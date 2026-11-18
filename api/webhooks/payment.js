import { 
  verifyRazorpaySignature, parseRazorpayEvent,
  verifyPhonePeSignature, parsePhonePeEvent,
  verifyCashfreeSignature, parseCashfreeEvent,
  verifyStripeSignature, parseStripeEvent
} from '../utils/webhookVerifier.js';
import { recordAndActivatePayment } from '../utils/cloudActivator.js';

/**
 * Unified Payment Webhook Dispatcher
 * Endpoint: /api/webhooks/payment
 * Auto-detects gateway based on headers or query parameter `?gateway=...`
 */
export default async function handler(req, res) {
  // Health check or status query
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'active',
      service: 'Billvector Webhook Dispatcher',
      supportedGateways: ['razorpay', 'phonepe', 'cashfree', 'stripe'],
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const queryGateway = (req.query?.gateway || '').toLowerCase();
    const headers = req.headers || {};
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    let detectedGateway = queryGateway;
    if (!detectedGateway) {
      if (headers['x-razorpay-signature']) {
        detectedGateway = 'razorpay';
      } else if (headers['x-verify']) {
        detectedGateway = 'phonepe';
      } else if (headers['x-webhook-signature']) {
        detectedGateway = 'cashfree';
      } else if (headers['stripe-signature']) {
        detectedGateway = 'stripe';
      }
    }

    if (!detectedGateway) {
      return res.status(400).json({
        error: 'Unable to detect payment gateway. Specify ?gateway=razorpay|phonepe|cashfree|stripe or include gateway signature headers.'
      });
    }

    let parsedEvent = null;
    let verification = { valid: false, error: 'Unknown gateway' };

    switch (detectedGateway) {
      case 'razorpay': {
        verification = verifyRazorpaySignature({
          rawBody,
          signature: headers['x-razorpay-signature'],
          secret: process.env.RAZORPAY_WEBHOOK_SECRET
        });
        if (verification.valid) {
          parsedEvent = parseRazorpayEvent(req.body);
        }
        break;
      }

      case 'phonepe': {
        const base64Response = typeof req.body === 'object' ? req.body.response : req.body;
        verification = verifyPhonePeSignature({
          base64Response,
          xVerifyHeader: headers['x-verify'],
          saltKey: process.env.PHONEPE_SALT_KEY,
          saltIndex: process.env.PHONEPE_SALT_INDEX || '1'
        });
        if (verification.valid) {
          parsedEvent = parsePhonePeEvent(base64Response);
        }
        break;
      }

      case 'cashfree': {
        verification = verifyCashfreeSignature({
          rawBody,
          signature: headers['x-webhook-signature'],
          timestamp: headers['x-webhook-timestamp'],
          secretKey: process.env.CASHFREE_SECRET_KEY
        });
        if (verification.valid) {
          parsedEvent = parseCashfreeEvent(req.body);
        }
        break;
      }

      case 'stripe': {
        verification = verifyStripeSignature({
          rawBody,
          signatureHeader: headers['stripe-signature'],
          endpointSecret: process.env.STRIPE_WEBHOOK_SECRET
        });
        if (verification.valid) {
          parsedEvent = parseStripeEvent(req.body);
        }
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported gateway: ${detectedGateway}` });
    }

    if (!verification.valid) {
      console.warn(`[WEBHOOK ${detectedGateway.toUpperCase()}] Signature verification failed:`, verification.error);
      return res.status(400).json({ error: verification.error });
    }

    const activation = await recordAndActivatePayment(parsedEvent);

    return res.status(200).json({
      status: 'success',
      gateway: detectedGateway,
      received: true,
      activation
    });
  } catch (err) {
    console.error('[UNIFIED WEBHOOK DISPATCHER ERROR]:', err);
    return res.status(500).json({ error: 'Internal server error processing payment webhook' });
  }
}
