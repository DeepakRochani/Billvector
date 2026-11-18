/**
 * Automated Cloud Activation Handler for Payment Webhooks
 * Records verified payments in Supabase and triggers instant subscription activation.
 */

const DEFAULT_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://wzoikmcpaempxnxosnve.supabase.co';
const DEFAULT_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6b2lrbWNwYWVtcHhueG9zbnZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwOTkyMDAsImV4cCI6MjEwODY3NTIwMH0.yyeaHLYEQA7v5jglCFBr1uTO1-P9sUmZg7pcZQXTyfE';

export async function recordAndActivatePayment(parsedEvent) {
  const {
    gateway,
    orderId,
    transactionId,
    amount,
    currency,
    customerName,
    customerEmail,
    planTier,
    isSuccessful,
    rawPayload
  } = parsedEvent;

  if (!isSuccessful) {
    return {
      status: 'ignored',
      message: `Event from ${gateway} is not a successful payment event.`
    };
  }

  const paymentRecord = {
    id: transactionId || `PAY_${Date.now()}`,
    gateway,
    order_id: orderId,
    transaction_id: transactionId,
    customer_name: customerName,
    customer_email: customerEmail,
    plan_tier: planTier,
    amount,
    currency: currency || 'INR',
    status: 'completed',
    raw_payload: rawPayload,
    user_id: 'admin'
  };

  try {
    // 1. Call Supabase process_payment_webhook RPC
    const rpcUrl = `${DEFAULT_SUPABASE_URL}/rest/v1/rpc/process_payment_webhook`;
    const rpcResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': DEFAULT_SUPABASE_KEY,
        'Authorization': `Bearer ${DEFAULT_SUPABASE_KEY}`
      },
      body: JSON.stringify({ payment_data: paymentRecord })
    });

    let rpcResult = null;
    if (rpcResponse.ok) {
      rpcResult = await rpcResponse.json();
    } else {
      const errText = await rpcResponse.text();
      console.warn('[WEBHOOK ACTIVATOR] Supabase RPC notice:', errText);
    }

    // 2. Broadcast via Supabase Realtime broadcast message
    try {
      const broadcastUrl = `${DEFAULT_SUPABASE_URL}/realtime/v1/api/broadcast`;
      await fetch(broadcastUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': DEFAULT_SUPABASE_KEY,
          'Authorization': `Bearer ${DEFAULT_SUPABASE_KEY}`
        },
        body: JSON.stringify({
          messages: [
            {
              topic: 'realtime:billvector-payments',
              event: 'payment.completed',
              payload: {
                paymentId: paymentRecord.id,
                gateway,
                orderId,
                transactionId,
                customerName,
                planTier,
                amount,
                activatedAt: new Date().toISOString()
              }
            }
          ]
        })
      });
    } catch (broadcastErr) {
      // Non-fatal broadcast warning
      console.warn('[WEBHOOK ACTIVATOR] Realtime broadcast warning:', broadcastErr.message);
    }

    return {
      status: 'activated',
      paymentId: paymentRecord.id,
      gateway,
      customerName,
      planTier,
      amount,
      rpcResult
    };
  } catch (err) {
    console.error('[WEBHOOK ACTIVATOR] Failed to record payment in Supabase:', err);
    return {
      status: 'local_only',
      paymentId: paymentRecord.id,
      gateway,
      customerName,
      planTier,
      amount,
      error: err.message
    };
  }
}
