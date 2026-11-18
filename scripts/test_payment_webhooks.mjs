import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  verifyRazorpaySignature,
  parseRazorpayEvent,
  verifyPhonePeSignature,
  parsePhonePeEvent,
  verifyCashfreeSignature,
  parseCashfreeEvent,
  verifyStripeSignature,
  parseStripeEvent
} from '../api/utils/webhookVerifier.js';

console.log('--- Running Payment Gateway Webhook Verifier Test Suite ---');

// 1. Razorpay Tests
{
  console.log('Testing Razorpay signature verification & payload parsing...');
  const secret = 'rzp_test_secret_key_12345';
  const rawBody = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_1234567890',
          order_id: 'order_987654321',
          amount: 59900,
          currency: 'INR',
          status: 'captured',
          email: 'test@drfilms.in',
          notes: {
            planTier: 'enterprise',
            customerName: 'Studio Pro Customer'
          }
        }
      }
    }
  });

  const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const invalidSignature = 'invalid_hex_signature_abc123';

  assert.strictEqual(verifyRazorpaySignature({ rawBody, signature: validSignature, secret }).valid, true, 'Valid Razorpay signature should pass');
  assert.strictEqual(verifyRazorpaySignature({ rawBody, signature: invalidSignature, secret }).valid, false, 'Invalid Razorpay signature should fail');
  assert.strictEqual(verifyRazorpaySignature({ rawBody, signature: validSignature, secret: 'wrong_secret' }).valid, false, 'Wrong secret should fail');

  const parsed = parseRazorpayEvent(JSON.parse(rawBody));
  assert.strictEqual(parsed.gateway, 'razorpay');
  assert.strictEqual(parsed.transactionId, 'pay_1234567890');
  assert.strictEqual(parsed.orderId, 'order_987654321');
  assert.strictEqual(parsed.amount, 599);
  assert.strictEqual(parsed.planTier, 'enterprise');
  assert.strictEqual(parsed.customerName, 'Studio Pro Customer');
  assert.strictEqual(parsed.customerEmail, 'test@drfilms.in');
  console.log('✓ Razorpay tests passed.');
}

// 2. PhonePe Tests
{
  console.log('Testing PhonePe signature verification & payload parsing...');
  const saltKey = 'phonepe_salt_key_0987654321';
  const saltIndex = '1';

  const decodedData = {
    success: true,
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantTransactionId: 'BV_ENTERPRISE_StudioPro_1700000000',
      transactionId: 'T26000000001',
      amount: 59900,
      state: 'COMPLETED',
      paymentInstrument: {
        type: 'UPI',
        utr: 'UTR12345678'
      }
    }
  };
  const base64Response = Buffer.from(JSON.stringify(decodedData)).toString('base64');
  const rawBody = JSON.stringify({ response: base64Response });

  const calculatedHash = crypto.createHash('sha256').update(base64Response + saltKey).digest('hex');
  const validXVerify = `${calculatedHash}###${saltIndex}`;
  const invalidXVerify = `wronghash12345###${saltIndex}`;

  assert.strictEqual(verifyPhonePeSignature({ base64Response, xVerifyHeader: validXVerify, saltKey, saltIndex }).valid, true, 'Valid PhonePe X-VERIFY should pass');
  assert.strictEqual(verifyPhonePeSignature({ base64Response, xVerifyHeader: invalidXVerify, saltKey, saltIndex }).valid, false, 'Invalid PhonePe X-VERIFY should fail');
  assert.strictEqual(verifyPhonePeSignature({ base64Response, xVerifyHeader: `${calculatedHash}###2`, saltKey, saltIndex }).valid, false, 'Wrong salt index should fail');

  const parsed = parsePhonePeEvent(JSON.parse(rawBody));
  assert.strictEqual(parsed.gateway, 'phonepe');
  assert.strictEqual(parsed.transactionId, 'T26000000001');
  assert.strictEqual(parsed.amount, 599);
  assert.strictEqual(parsed.planTier, 'enterprise');
  assert.strictEqual(parsed.isSuccessful, true);
  console.log('✓ PhonePe tests passed.');
}

// 3. Cashfree Tests
{
  console.log('Testing Cashfree signature verification & payload parsing...');
  const secretKey = 'cashfree_secret_sandbox_key_xyz';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: {
      order: {
        order_id: 'CF_ORDER_1001',
        order_amount: 199,
        order_currency: 'INR',
        order_tags: {
          planTier: 'starter',
          customerName: 'Starter Studio'
        }
      },
      payment: {
        cf_payment_id: 'CF_PAY_998877',
        payment_status: 'SUCCESS',
        payment_amount: 199
      },
      customer_details: {
        customer_name: 'Starter Studio',
        customer_email: 'starter@drfilms.in'
      }
    }
  });

  const payloadToSign = timestamp + rawBody;
  const validSignature = crypto.createHmac('sha256', secretKey).update(payloadToSign).digest('base64');
  const invalidSignature = 'invalid_cashfree_signature_base64';

  assert.strictEqual(verifyCashfreeSignature({ rawBody, signature: validSignature, timestamp, secretKey }).valid, true, 'Valid Cashfree signature should pass');
  assert.strictEqual(verifyCashfreeSignature({ rawBody, signature: invalidSignature, timestamp, secretKey }).valid, false, 'Invalid Cashfree signature should fail');

  const parsed = parseCashfreeEvent(JSON.parse(rawBody));
  assert.strictEqual(parsed.gateway, 'cashfree');
  assert.strictEqual(parsed.transactionId, 'CF_PAY_998877');
  assert.strictEqual(parsed.orderId, 'CF_ORDER_1001');
  assert.strictEqual(parsed.amount, 199);
  assert.strictEqual(parsed.planTier, 'starter');
  assert.strictEqual(parsed.customerName, 'Starter Studio');
  console.log('✓ Cashfree tests passed.');
}

// 4. Stripe Tests
{
  console.log('Testing Stripe signature verification & payload parsing...');
  const endpointSecret = 'whsec_test_stripe_secret_key_abcdef';
  const now = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    id: 'evt_stripe_test_123',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_session_123',
        payment_intent: 'pi_3Pabcdefghijklm',
        amount_total: 29900,
        currency: 'inr',
        status: 'complete',
        customer_details: {
          name: 'Stripe Studio User',
          email: 'stripeuser@drfilms.in'
        },
        metadata: {
          planTier: 'pro',
          customerName: 'Stripe Studio User'
        }
      }
    }
  });

  const signedPayload = `${now}.${rawBody}`;
  const validHex = crypto.createHmac('sha256', endpointSecret).update(signedPayload).digest('hex');
  const stripeHeader = `t=${now},v1=${validHex}`;

  assert.strictEqual(verifyStripeSignature({ rawBody, signatureHeader: stripeHeader, endpointSecret, toleranceSeconds: 300 }).valid, true, 'Valid Stripe header should pass');
  assert.strictEqual(verifyStripeSignature({ rawBody, signatureHeader: `t=${now},v1=wrong_hex_signature`, endpointSecret, toleranceSeconds: 300 }).valid, false, 'Invalid Stripe header should fail');

  // Skew tolerance test (replay attack prevention)
  const oldTimestamp = now - 400; // older than 300 seconds tolerance
  const oldSignedPayload = `${oldTimestamp}.${rawBody}`;
  const oldHex = crypto.createHmac('sha256', endpointSecret).update(oldSignedPayload).digest('hex');
  const expiredStripeHeader = `t=${oldTimestamp},v1=${oldHex}`;
  assert.strictEqual(verifyStripeSignature({ rawBody, signatureHeader: expiredStripeHeader, endpointSecret, toleranceSeconds: 300 }).valid, false, 'Expired Stripe timestamp should fail tolerance check');

  const parsed = parseStripeEvent(JSON.parse(rawBody));
  assert.strictEqual(parsed.gateway, 'stripe');
  assert.strictEqual(parsed.transactionId, 'pi_3Pabcdefghijklm');
  assert.strictEqual(parsed.orderId, 'cs_test_session_123');
  assert.strictEqual(parsed.amount, 299);
  assert.strictEqual(parsed.planTier, 'pro');
  assert.strictEqual(parsed.customerName, 'Stripe Studio User');
  console.log('✓ Stripe tests passed.');
}

console.log('ALL PAYMENT GATEWAY WEBHOOK TESTS PASSED SUCCESSFULLY!');
