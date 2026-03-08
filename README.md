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

```http
POST /applications
Content-Type: application/json
```

Body: loan application JSON. Returns the application with final status (`approved`, `denied`, `flagged_for_review`, or `disbursement_queued`).

### Disbursement Webhook

```http
POST /webhook/disbursement
Content-Type: application/json
```

```json
{
  "application_id": "...",
  "status": "success | failed",
  "transaction_id": "txn_abc",
  "timestamp": "2026-01-15T10:30:00Z"
}
```

Idempotent: replaying the same `transaction_id` returns 200 with no state change.

### Admin Endpoints (Basic Auth: admin / password)

```http
GET  /admin/applications?status=flagged_for_review
GET  /admin/applications/:id
POST /admin/applications/:id/review
```

Review body:

```json
{
  "decision": "approved | denied | partially_approved",
  "note": "optional note",
  "approved_loan_amount": 800
}
```

### Webhook Simulator

```bash
node scripts/simulate_disbursement.js <application_id> [--mode success|failure|replay|retry-flow]
```

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

**Notes:**

- Income level uses the lower of stated vs documented income (conservative).
- Idempotency uses `transaction_id` (external); retries get a new `retry_id` in the audit log.
- Applications stuck in `disbursement_queued` > 24h are escalated to `flagged_for_review`.

---

## Design Decisions

1. **Income Verification Tolerance** — Symmetric ±10%: `|documented - stated| / stated <= 0.10`. Null documented income → 0 pts.

2. **Income Level** — Uses the lower of stated vs documented income to prevent inflated stated figures from passing the income level check.

3. **Account Stability Nulls** — Missing bank data scores 50% (neutral), not 0. Missing docs ≠ a problem; flags for manual review instead of auto-deny.

4. **DTI Scoring** — Continuous linear scale: `max(0, (1 - withdrawals/deposits) × 100)`. Preserves gradient vs binary pass/fail.

5. **`partially_approved` State** — Added as a first-class status: `flagged_for_review → partially_approved → disbursement_queued → disbursed | disbursement_failed`. No existing transitions changed.

6. **Retry vs Audit Trail** — `transaction_id` (external) is the idempotency key; same webhook twice → no-op. `retry_id` (internal uuid) is the audit key; every failure event gets its own record. Retries are not replays.

7. **Disbursement Timeout** — Applications in `disbursement_queued` > 24h are escalated to `flagged_for_review` by a background job (runs every minute).

---

## Tradeoffs

- **Symmetric vs directional income tolerance** — A one-sided tolerance (only penalizing understatement) would be more permissive but would miss cases where documented income is suspiciously *above* stated (irregular income, data error). Symmetric catches both directions at the cost of occasionally flagging benign discrepancies.

- **Conservative income for level check** — Using the lower of stated vs documented closes a gap where an applicant could pass the income level check on inflated stated figures even when docs show less. The cost is being stricter than stated income alone would be.

- **Neutral nulls vs zero for missing bank data** — Scoring nulls as 0 would auto-deny applicants who simply haven't uploaded docs yet. Neutral (50%) + manual review is more permissive but avoids false denials. A bad actor could exploit this by omitting docs intentionally, but that risk is mitigated by the manual review step.

- **Continuous DTI vs binary** — Binary pass/fail loses gradient information (0.25 and 0.74 would score the same). Continuous scoring is more accurate but harder to explain to applicants than a simple cutoff.

- **Retry vs audit trail (product vs finance conflict)** — Product wants idempotent retries; Finance wants a distinct audit record per retry. Resolved by using orthogonal keys: `transaction_id` for idempotency, `retry_id` for audit. Each retry produces a new `retry_id` in the audit log while still being deduplicated by `transaction_id` if the same webhook arrives twice.

---

## Tests

```bash
npm test
```

---

## Architecture

```
src/
  config/index.ts          Configurable values (weights, thresholds, timeouts)
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
tests/
  scenarios.test.ts        Integration test scenarios
```

**Database:** SQLite via `better-sqlite3` (WAL mode). Three tables:

- `applications` — primary records with status, score, retry count
- `audit_log` — immutable event log for every state transition
- `processed_webhooks` — idempotency table keyed on `transaction_id`
