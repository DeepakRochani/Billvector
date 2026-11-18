/**
 * Payment Gateway Integration & Webhook Coordination Engine for Billvector.
 * 
 * Supports:
 * - Razorpay (UPI, Credit/Debit Cards, Netbanking)
 * - PhonePe (Instant App Deep Link & Dynamic UPI QR)
 * - Cashfree (Cards, UPI, Netbanking, Wallets)
 * - Stripe (International Cards & Apple Pay)
 * - Local & Cloud Webhook Simulation Engine
 */

import { db } from '../db/db.js';
import { PLAN_TIERS, activateSubscriptionWithPayment } from './licenseManager.js';
import { getSupabase } from '../config/supabase.js';

export const GATEWAY_METADATA = {
  razorpay: {
    id: 'razorpay',
    name: 'Razorpay',
    badge: 'Popular (India)',
    description: 'UPI, Debit/Credit Cards, Netbanking & Wallets',
    webhookPath: '/api/webhooks/razorpay',
    currency: 'INR',
    testKey: 'rzp_test_billvector',
    color: 'sky'
  },
  phonepe: {
    id: 'phonepe',
    name: 'PhonePe',
    badge: 'Instant UPI',
    description: 'Direct PhonePe App payment & dynamic UPI QR',
    webhookPath: '/api/webhooks/phonepe',
    currency: 'INR',
    testKey: 'PHONEPE_TEST_MERCHANT',
    color: 'purple'
  },
  cashfree: {
    id: 'cashfree',
    name: 'Cashfree',
    badge: 'Fast Checkout',
    description: 'All Indian payment modes with low transaction fees',
    webhookPath: '/api/webhooks/cashfree',
    currency: 'INR',
    testKey: 'CF_TEST_APP_ID',
    color: 'emerald'
  },
  stripe: {
    id: 'stripe',
    name: 'Stripe',
    badge: 'Global / Cards',
    description: 'International Credit Cards & Apple Pay',
    webhookPath: '/api/webhooks/stripe',
    currency: 'USD',
    testKey: 'pk_test_billvector',
    color: 'amber'
  }
};

/**
 * Build PhonePe Direct UPI Deep Link with order metadata
 */
export function buildPhonePeDeepLink({ amount, merchantTxnId, payeeUpi = 'drfilms@hdfcbank', payeeName = 'Billvector' }) {
  const cleanAmount = Number(amount || 0).toFixed(2);
  const cleanTxnId = encodeURIComponent(merchantTxnId || `BV_${Date.now()}`);
  const cleanName = encodeURIComponent(payeeName.trim());
  return `phonepe://pay?pa=${encodeURIComponent(payeeUpi)}&pn=${cleanName}&am=${cleanAmount}&cu=INR&tr=${cleanTxnId}&mc=5499`;
}

/**
 * Client-Side Realtime Webhook Listener
 * Listens for payment activations on Supabase Realtime channel `billvector-payments`
 * and applies them directly into local Dexie IndexedDB.
 */
export function initPaymentWebhookListener(onActivated) {
  if (typeof window === 'undefined') return () => {};

  const handleCustomEvent = async (e) => {
    const detail = e.detail || {};
    if (detail.planTier) {
      try {
        await activateSubscriptionWithPayment({
          planTier: detail.planTier,
          isLifetime: detail.isLifetime || detail.planTier === 'enterprise',
          durationDays: detail.durationDays || (detail.isLifetime ? 0 : 365),
          paymentMethod: detail.gateway ? detail.gateway.toUpperCase() : 'GATEWAY_WEBHOOK',
          transactionRef: detail.transactionId || detail.orderId || 'WEBHOOK_' + Date.now().toString(36),
          amount: detail.amount || 0,
          customerName: detail.customerName || 'Studio Customer',
          allowedFeatures: ['*']
        });
        if (typeof onActivated === 'function') {
          onActivated(detail);
        }
      } catch (err) {
        console.warn('[PAYMENT WEBHOOK LISTENER] Local activation notice:', err);
      }
    }
  };

  window.addEventListener('billvector:payment-activated', handleCustomEvent);

  // Supabase Realtime listener
  let channel = null;
  const client = getSupabase();
  if (client) {
    try {
      channel = client
        .channel('billvector-payments')
        .on('broadcast', { event: 'payment.completed' }, async (payload) => {
          const data = payload.payload || {};
          window.dispatchEvent(new CustomEvent('billvector:payment-activated', { detail: data }));
        })
        .subscribe();
    } catch (err) {
      console.warn('[PAYMENT WEBHOOK LISTENER] Supabase subscription notice:', err);
    }
  }

  return () => {
    window.removeEventListener('billvector:payment-activated', handleCustomEvent);
    if (channel && client) {
      try {
        client.removeChannel(channel);
      } catch {}
    }
  };
}

/**
 * Simulate / Test Webhook locally and send to /api/webhooks/payment
 * Used by Admin Portal Tester and Subscription Checkout simulator
 */
export async function simulateWebhookPayment({
  gateway = 'razorpay',
  planTier = 'pro',
  customerName = 'Studio Customer',
  customerEmail = 'customer@example.com',
  amount = 0,
  transactionRef = ''
}) {
  const planInfo = PLAN_TIERS[planTier] || PLAN_TIERS.pro;
  const targetAmount = amount || planInfo.price || 0;
  const targetTxn = transactionRef.trim() || `${gateway.toUpperCase()}_TXN_${Date.now().toString(36).toUpperCase()}`;
  const targetOrderId = `ORD_${gateway.toUpperCase()}_${Date.now().toString(36).toUpperCase()}`;

  // 1. Construct realistic gateway mock payloads
  let mockPayload = {};
  let mockHeaders = {
    'Content-Type': 'application/json'
  };

  if (gateway === 'razorpay') {
    mockPayload = {
      id: `evt_${Date.now()}`,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: targetTxn,
            order_id: targetOrderId,
            amount: targetAmount * 100, // in paise
            currency: 'INR',
            status: 'captured',
            email: customerEmail,
            notes: {
              planTier,
              customerName,
              customerEmail,
              orderId: targetOrderId
            }
          }
        }
      }
    };
    mockHeaders['x-razorpay-signature'] = 'simulated_valid_test_signature';
  } else if (gateway === 'phonepe') {
    const rawData = {
      success: true,
      code: 'PAYMENT_SUCCESS',
      data: {
        merchantTransactionId: `BV_${planTier.toUpperCase()}_${encodeURIComponent(customerName)}_${Date.now()}`,
        transactionId: targetTxn,
        amount: targetAmount * 100,
        state: 'COMPLETED',
        paymentInstrument: {
          type: 'UPI',
          phone: '9876543210'
        }
      }
    };
    const jsonStr = JSON.stringify(rawData);
    let b64 = '';
    try {
      b64 = btoa(unescape(encodeURIComponent(jsonStr)));
    } catch {
      b64 = btoa(jsonStr);
    }
    mockPayload = { response: b64 };
    mockHeaders['x-verify'] = 'simulated_phonepe_xverify_hash###1';
  } else if (gateway === 'cashfree') {
    mockPayload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: {
          order_id: targetOrderId,
          order_amount: targetAmount,
          order_currency: 'INR',
          order_tags: {
            planTier,
            customerName
          }
        },
        payment: {
          cf_payment_id: targetTxn,
          payment_status: 'SUCCESS',
          payment_amount: targetAmount
        },
        customer_details: {
          customer_name: customerName,
          customer_email: customerEmail
        }
      }
    };
    mockHeaders['x-webhook-signature'] = 'simulated_cashfree_signature';
    mockHeaders['x-webhook-timestamp'] = String(Math.floor(Date.now() / 1000));
  } else if (gateway === 'stripe') {
    mockPayload = {
      id: `evt_test_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: targetOrderId,
          payment_intent: targetTxn,
          amount_total: targetAmount * 100,
          currency: 'inr',
          status: 'complete',
          customer_details: {
            name: customerName,
            email: customerEmail
          },
          metadata: {
            planTier,
            customerName,
            customerEmail
          }
        }
      }
    };
    mockHeaders['stripe-signature'] = `t=${Math.floor(Date.now() / 1000)},v1=simulated_stripe_signature`;
  }

  // 2. Fire request to /api/webhooks/payment or fallback to local activation
  let apiSuccess = false;
  let serverResponse = null;

  try {
    const res = await fetch(`/api/webhooks/payment?gateway=${gateway}`, {
      method: 'POST',
      headers: mockHeaders,
      body: JSON.stringify(mockPayload)
    });
    if (res.ok) {
      apiSuccess = true;
      serverResponse = await res.json();
    } else {
      serverResponse = await res.text();
    }
  } catch (netErr) {
    // Expected in standalone browser/preview without backend active
    serverResponse = 'Network offline or local dev without serverless runtime: ' + netErr.message;
  }

  // 3. Guarantee immediate local activation in Dexie IndexedDB
  const localResult = await activateSubscriptionWithPayment({
    planTier,
    durationDays: planTier === 'enterprise' ? 0 : 365,
    isLifetime: planTier === 'enterprise',
    paymentMethod: gateway.toUpperCase(),
    transactionRef: targetTxn,
    amount: targetAmount,
    allowedFeatures: ['*'],
    customerName
  });

  // 4. Update customer directory
  try {
    const existingCustRec = (await db.settings.get('admin_customer_directory')) || { key: 'admin_customer_directory', data: [] };
    const list = Array.isArray(existingCustRec.data) ? existingCustRec.data : [];
    const updatedCustItem = {
      id: targetOrderId,
      customerName,
      customerEmail,
      planTier,
      isLifetime: planTier === 'enterprise',
      issueDate: new Date().toISOString().split('T')[0],
      expiryDate: planTier === 'enterprise' ? null : new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0],
      billLimit: planInfo.maxBills || null,
      allowedFeatures: ['*'],
      licenseKey: null,
      notes: `Automated ${gateway.toUpperCase()} Webhook activation (${targetTxn})`,
      createdAt: new Date().toISOString()
    };
    const updatedList = [updatedCustItem, ...list.filter(c => c.customerName !== customerName)];
    await db.settings.put({ key: 'admin_customer_directory', data: updatedList });
  } catch (dirErr) {
    console.warn('[SIMULATE WEBHOOK] Directory notice:', dirErr);
  }

  // 5. Dispatch window event for live active components
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('billvector:payment-activated', {
      detail: {
        gateway,
        orderId: targetOrderId,
        transactionId: targetTxn,
        customerName,
        planTier,
        amount: targetAmount,
        isLifetime: planTier === 'enterprise'
      }
    }));
  }

  return {
    success: true,
    gateway,
    planTier,
    customerName,
    amount: targetAmount,
    transactionRef: targetTxn,
    orderId: targetOrderId,
    serverDispatched: apiSuccess,
    serverResponse,
    localResult
  };
}
