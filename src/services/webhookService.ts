import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { config } from '../config';
import { WebhookPayload, ApplicationStatus } from '../models/types';
import { WebhookReplayError, ApplicationNotFoundError } from '../errors';
import { getApplicationById, transitionStatus, logAuditEvent } from './applicationService';

/**
 * Processes an incoming disbursement webhook.
 *
 * Idempotency contract:
 *   - If transaction_id has been seen before → WebhookReplayError (no state change)
 *   - First-time processing → update state, record in processed_webhooks
 *
 * Retry vs. audit trail reconciliation:
 *   - Idempotency (replay protection) is keyed on transaction_id: same
 *     external ID arriving twice = no-op, prevents double-processing.
 *   - Retries are initiated by OUR system with a fresh retry_id in the
 *     audit log. Each retry is a distinct audit event with its own ID,
 *     satisfying the finance team's unique-audit-record requirement.
 *   - These are orthogonal concerns: replay = "same webhook, different
 *     delivery"; retry = "new attempt, new record".
 */
export function processDisbursementWebhook(payload: WebhookPayload): {
  application: ReturnType<typeof getApplicationById>;
  replayed: boolean;
} {
  const db = getDb();

  // ── Idempotency check ──────────────────────────────────────────────────────
  const existing = db
    .prepare('SELECT * FROM processed_webhooks WHERE transaction_id = ?')
    .get(payload.transaction_id) as { application_id: string } | undefined;

  if (existing) {
    throw new WebhookReplayError(payload.transaction_id, existing.application_id);
  }

  // ── Application lookup ─────────────────────────────────────────────────────
  const app = getApplicationById(payload.application_id);

  if (app.status !== ApplicationStatus.DisbursementQueued) {
    throw new Error(
      `Cannot process disbursement webhook: application ${payload.application_id} ` +
      `is in status '${app.status}', expected 'disbursement_queued'`
    );
  }

  // ── Process webhook ────────────────────────────────────────────────────────
  let resultStatus: ApplicationStatus;

  if (payload.status === 'success') {
    resultStatus = ApplicationStatus.Disbursed;
    transitionStatus(app.id, ApplicationStatus.DisbursementQueued, ApplicationStatus.Disbursed);

    logAuditEvent(app.id, 'disbursement_success', ApplicationStatus.DisbursementQueued, ApplicationStatus.Disbursed, {
      transaction_id: payload.transaction_id,
      timestamp: payload.timestamp,
    });
  } else {
    // Failure: check retry count
    const newRetryCount = app.retry_count + 1;
    const maxRetries = config.disbursement.maxRetries;

    if (newRetryCount >= maxRetries) {
      // Max retries exceeded → escalate to manual review
      resultStatus = ApplicationStatus.FlaggedForReview;

      // First: failed → disbursement_failed, then disbursement_failed → flagged_for_review
      transitionStatus(
        app.id,
        ApplicationStatus.DisbursementQueued,
        ApplicationStatus.DisbursementFailed,
        { retry_count: newRetryCount }
      );

      const retryId = uuidv4();
      logAuditEvent(app.id, 'disbursement_failure', ApplicationStatus.DisbursementQueued, ApplicationStatus.DisbursementFailed, {
        transaction_id: payload.transaction_id,
        retry_id: retryId, // unique per retry, satisfies finance audit requirement
        attempt_number: newRetryCount,
        timestamp: payload.timestamp,
        reason: 'Max retries exceeded — escalating to manual review',
      });

      transitionStatus(
        app.id,
        ApplicationStatus.DisbursementFailed,
        ApplicationStatus.FlaggedForReview
      );

      logAuditEvent(app.id, 'disbursement_escalated', ApplicationStatus.DisbursementFailed, ApplicationStatus.FlaggedForReview, {
        retry_id: retryId,
        total_attempts: newRetryCount,
        reason: 'Max retries exceeded',
      });
    } else {
      // Under max retries → re-queue for retry
      resultStatus = ApplicationStatus.DisbursementQueued;

      transitionStatus(
        app.id,
        ApplicationStatus.DisbursementQueued,
        ApplicationStatus.DisbursementFailed,
        { retry_count: newRetryCount }
      );

      const retryId = uuidv4();
      logAuditEvent(app.id, 'disbursement_failure', ApplicationStatus.DisbursementQueued, ApplicationStatus.DisbursementFailed, {
        transaction_id: payload.transaction_id,
        retry_id: retryId, // unique per retry attempt
        attempt_number: newRetryCount,
        timestamp: payload.timestamp,
        reason: `Failure ${newRetryCount}/${maxRetries} — will retry`,
      });

      transitionStatus(
        app.id,
        ApplicationStatus.DisbursementFailed,
        ApplicationStatus.DisbursementQueued,
        { disbursement_queued_at: new Date().toISOString() }
      );

      logAuditEvent(app.id, 'disbursement_retry_queued', ApplicationStatus.DisbursementFailed, ApplicationStatus.DisbursementQueued, {
        retry_id: retryId,
        attempt_number: newRetryCount,
      });
    }
  }

  // ── Record processed webhook (idempotency) ─────────────────────────────────
  db.prepare(
    `INSERT INTO processed_webhooks (transaction_id, application_id, webhook_status, result_status, processed_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    payload.transaction_id,
    payload.application_id,
    payload.status,
    resultStatus,
    new Date().toISOString()
  );

  return { application: getApplicationById(payload.application_id), replayed: false };
}
