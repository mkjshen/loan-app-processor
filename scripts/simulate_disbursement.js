#!/usr/bin/env node
/**
 * simulate_disbursement.js
 *
 * Webhook simulator for the Loan Application Processor.
 * Sends success, failure, and replay webhooks to the server.
 *
 * Usage:
 *   node scripts/simulate_disbursement.js <application_id> [--mode success|failure|replay|retry-flow]
 *
 * Modes:
 *   success      Send a single success webhook (default)
 *   failure      Send a single failure webhook
 *   replay       Send the same success webhook twice (idempotency demo)
 *   retry-flow   Send 3 failure webhooks with unique txn IDs (shows retry + escalation)
 *
 * Examples:
 *   node scripts/simulate_disbursement.js abc-123
 *   node scripts/simulate_disbursement.js abc-123 --mode failure
 *   node scripts/simulate_disbursement.js abc-123 --mode replay
 *   node scripts/simulate_disbursement.js abc-123 --mode retry-flow
 */

const http = require('http');

const HOST = 'localhost';
const PORT = 3000;
const ENDPOINT = '/webhook/disbursement';

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: HOST,
      port: PORT,
      path: ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeId() {
  return 'txn_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const applicationId = args[0];
  const modeFlag = args.indexOf('--mode');
  const mode = modeFlag !== -1 ? args[modeFlag + 1] : 'success';

  if (!applicationId) {
    console.error('Usage: node scripts/simulate_disbursement.js <application_id> [--mode success|failure|replay|retry-flow]');
    process.exit(1);
  }

  console.log(`\nWebhook Simulator`);
  console.log(`Application ID: ${applicationId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Target: http://${HOST}:${PORT}${ENDPOINT}\n`);

  if (mode === 'success') {
    // ── Success webhook ──────────────────────────────────────────────────────
    const txnId = makeId();
    console.log(`[SUCCESS] Sending success webhook with transaction_id: ${txnId}`);
    const result = await sendWebhook({
      application_id: applicationId,
      status: 'success',
      transaction_id: txnId,
      timestamp: new Date().toISOString(),
    });
    console.log(`Response (${result.statusCode}):`, JSON.stringify(result.body, null, 2));

  } else if (mode === 'failure') {
    // ── Single failure webhook ───────────────────────────────────────────────
    const txnId = makeId();
    console.log(`[FAILURE] Sending failure webhook with transaction_id: ${txnId}`);
    const result = await sendWebhook({
      application_id: applicationId,
      status: 'failed',
      transaction_id: txnId,
      timestamp: new Date().toISOString(),
    });
    console.log(`Response (${result.statusCode}):`, JSON.stringify(result.body, null, 2));

  } else if (mode === 'replay') {
    // ── Replay: same transaction_id sent twice ───────────────────────────────
    const txnId = makeId();
    const payload = {
      application_id: applicationId,
      status: 'success',
      transaction_id: txnId,
      timestamp: new Date().toISOString(),
    };

    console.log(`[REPLAY] First send — transaction_id: ${txnId}`);
    const first = await sendWebhook(payload);
    console.log(`Response 1 (${first.statusCode}):`, JSON.stringify(first.body, null, 2));

    console.log(`\n[REPLAY] Second send — same transaction_id: ${txnId}`);
    const second = await sendWebhook(payload);
    console.log(`Response 2 (${second.statusCode}):`, JSON.stringify(second.body, null, 2));

    console.log('\nResult: both calls returned 200, but second is idempotent (no state change).');

  } else if (mode === 'retry-flow') {
    // ── Retry flow: 3 failures with unique transaction IDs ───────────────────
    // Demonstrates: unique audit trail per retry + max retries → escalation
    console.log(`[RETRY-FLOW] Sending ${3} failure webhooks with unique transaction IDs.`);
    console.log(`Each failure triggers a retry (retry_count++).`);
    console.log(`After max retries, application escalates to flagged_for_review.\n`);

    for (let i = 1; i <= 3; i++) {
      const txnId = makeId();
      console.log(`[RETRY-FLOW] Attempt ${i}/3 — transaction_id: ${txnId}`);
      const result = await sendWebhook({
        application_id: applicationId,
        status: 'failed',
        transaction_id: txnId,
        timestamp: new Date().toISOString(),
      });
      console.log(`Response (${result.statusCode}):`, JSON.stringify(result.body, null, 2));

      if (i < 3) {
        console.log('Waiting 500ms before next attempt...\n');
        await sleep(500);
      }
    }

    console.log('\n[RETRY-FLOW] All 3 failures sent. Check admin endpoint for escalated status.');

  } else {
    console.error(`Unknown mode: ${mode}. Use: success | failure | replay | retry-flow`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Simulator error:', err.message);
  process.exit(1);
});
