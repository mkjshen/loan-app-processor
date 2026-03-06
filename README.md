# Loan Application Processor

AI-powered loan application backend with scoring engine, state machine, and webhook disbursement flow.

## Setup

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`.

---

## API Reference

### Submit Application
```
POST /applications
Content-Type: application/json
```
Body: loan application JSON (see test scenarios below).

Returns the application with final status (`approved`, `denied`, `flagged_for_review`, or `disbursement_queued`).

### Disbursement Webhook
```
POST /webhook/disbursement
Content-Type: application/json

{
  "application_id": "...",
  "status": "success" | "failed",
  "transaction_id": "txn_abc",
  "timestamp": "2026-01-15T10:30:00Z"
}
```

Idempotent: replaying the same `transaction_id` returns 200 with no state change.

### Admin Endpoints (Basic Auth: admin / password)
```
GET  /admin/applications?status=flagged_for_review
GET  /admin/applications/:id
POST /admin/applications/:id/review
```

Review body:
```json
{
  "decision": "approved" | "denied" | "partially_approved",
  "note": "optional note",
  "approved_loan_amount": 800
}
```

### Webhook Simulator
```bash
node scripts/simulate_disbursement.js <application_id> [--mode success|failure|replay|retry-flow]
```

---

## Design Decisions & Interpretations

### 1. Income Verification Tolerance (10%)

**Interpretation: symmetric ±10% around stated income.**

Formula: `|documented - stated| / stated <= 0.10`

**Rationale:** "10% tolerance" most naturally means a band around the stated value, not directional. Both directions of mismatch are informative:
- Documented income significantly *below* stated → applicant may be overstating income (fraud risk).
- Documented income significantly *above* stated → unusual; could indicate irregular income, bonus timing, or data entry error.

A symmetric band catches both cases. A purely downward tolerance (only penalizing understatement) would be more permissive but would miss the "above" anomalies. A purely upward tolerance (only penalizing overstatement) would miss the fraud risk direction.

**Null documented income → 0 points.** Unverifiable income cannot be credited, but the application can still score well on other factors and be flagged for manual review.

### 2. Income Level (conservative income)

For income level scoring, I use the **lower of stated vs documented** income (when documented is available), not stated income alone.

**Rationale:** Using stated income for the income level check while separately penalizing mismatches in the verification factor would allow a borrower to pass income level on inflated stated figures even when documentation shows lower income. Using the conservative figure closes this gap.

### 3. Account Stability — Null Values

Null financial data (missing bank statements) is treated as **neutral (50% of sub-factor points)**, not zero.

**Rationale:** Missing documentation is not proof of a problem. Penalizing nulls as hard failures would auto-deny applicants who simply haven't uploaded documents yet. Neutral scoring + manual review (if total score is 50–74) is the appropriate outcome. See Scenario 5 (Carol Tester).

### 4. Debt-to-Income — Continuous Scoring

DTI uses a **continuous linear scale**: `score = max(0, (1 - ratio) * 100)` where `ratio = withdrawals / deposits`.

**Rationale:** Binary pass/fail on DTI loses information. A ratio of 0.25 (spending 25% of income) should score higher than 0.74 (spending 74%) even if both are "below 0.75." Continuous scoring captures this gradient naturally.

### 5. State Machine — `partially_approved`

Added as a first-class status in the state machine transitions:

```
flagged_for_review → partially_approved → disbursement_queued → disbursed | disbursement_failed
```

**No existing transitions were changed.** The `partially_approved` state is simply a new node in the graph. Existing applications that were approved/denied before this state existed are unaffected — their transitions are still valid, and the new state is only reachable via admin review on a flagged application.

### 6. Retry vs. Audit Trail Tradeoff

**Conflict:** Product wants auto-retry (same failure = same operation), but Finance wants each retry as a distinct audit record.

**Resolution:** These are orthogonal concerns keyed on different identifiers:

- **`transaction_id`** (from external webhook) = idempotency key. Same `transaction_id` arriving twice → replay → no-op, no state change.
- **`retry_id`** (generated internally per failure event) = audit key. Every failure event in our audit log gets its own `uuid`. This satisfies the unique-audit-record requirement.

Retries are not replays. A replay is "the payment processor sent the same webhook twice (network glitch)." A retry is "we've processed a new failure from a new disbursement attempt and are queuing another try." They produce different `transaction_id`s from the external system and different `retry_id`s in our audit log.

### 7. Disbursement Timeout

Applications stuck in `disbursement_queued` for more than `config.disbursement.timeoutMinutes` (default: 24 hours) are escalated to `flagged_for_review` by a background job that runs every minute.

### 8. Scenario 4 — Borderline Case

Jane Doe's $4,500 loan (Scenario 4) scores **72.5** with this model:
- Income Verification: 30 pts (docs match within 4%)
- Income Level: 0 pts (4,800/4,500 = 1.07x, below the 3x threshold)
- Account Stability: 20 pts (all clear)
- Employment Status: 15 pts (employed)
- DTI: 7.5 pts (continuous: (1 - 0.25) * 100 * 0.10 = 7.5)

Total: **72.5 → flagged for review** ✓

---

## Scoring Rubric

| Factor | Weight | Method |
|--------|--------|--------|
| Income Verification | 30% | Binary: documented within ±10% of stated |
| Income Level | 25% | Binary: conservative income ≥ 3× loan amount |
| Account Stability | 20% | 3 sub-factors, each 33.3 pts; null = 50% neutral |
| Employment Status | 15% | Tiered: employed=100, self-employed=50, unemployed=0 |
| Debt-to-Income | 10% | Continuous: max(0, (1 - withdrawals/deposits) × 100) |

**Thresholds (config-driven):**
- ≥ 75 → Auto-approve → disbursement_queued
- 50–74 → Flag for manual review
- < 50 → Auto-deny

---

## Test Scenarios

Run all test scenarios:
```bash
node scripts/run_tests.js
```

Or manually with curl:
```bash
# Scenario 1 — Auto-approve
curl -s -X POST http://localhost:3000/applications \
  -H "Content-Type: application/json" \
  -d '{"applicant_name":"Jane Doe","email":"jane.doe@example.com","loan_amount":1500,"stated_monthly_income":5000,"employment_status":"employed","documented_monthly_income":4800,"bank_ending_balance":3200,"bank_has_overdrafts":false,"bank_has_consistent_deposits":true,"monthly_withdrawals":1200,"monthly_deposits":4800}' | jq .
```

---

## Architecture

```
src/
  config/index.ts          All configurable values (weights, thresholds, timeouts)
  models/types.ts          ApplicationStatus enum, interfaces
  errors/index.ts          Typed error classes
  db/index.ts              SQLite setup + schema migration
  services/
    scorer.ts              Scoring engine (pure functions)
    stateMachine.ts        State transition enforcement
    applicationService.ts  Orchestration (submit, review, audit)
    webhookService.ts      Webhook processing + idempotency
  middleware/
    auth.ts                Basic auth
    errorHandler.ts        Global typed error → HTTP response
  routes/
    applications.ts        POST /applications
    webhook.ts             POST /webhook/disbursement
    admin.ts               GET/POST /admin/applications
  app.ts                   Express setup + background jobs
scripts/
  simulate_disbursement.js Webhook simulator (success/failure/replay/retry-flow)
```

**Database:** SQLite via `better-sqlite3` (WAL mode). Three tables:
- `applications` — primary records with status, score, retry count
- `audit_log` — immutable event log for every state transition
- `processed_webhooks` — idempotency table keyed on `transaction_id`
