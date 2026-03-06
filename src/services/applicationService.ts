import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { config } from '../config';
import { ApplicationInput, Application, ApplicationStatus, ScoreBreakdown } from '../models/types';
import { DuplicateApplicationError, ApplicationNotFoundError, ValidationError } from '../errors';
import { scoreApplication, decideFromScore } from './scorer';
import { assertValidTransition } from './stateMachine';

// ─── DB row → Application ───────────────────────────────────────────────────

function rowToApplication(row: Record<string, unknown>): Application {
  return {
    ...row,
    bank_has_overdrafts: row.bank_has_overdrafts === null ? null : Boolean(row.bank_has_overdrafts),
    bank_has_consistent_deposits:
      row.bank_has_consistent_deposits === null ? null : Boolean(row.bank_has_consistent_deposits),
    score_breakdown: row.score_breakdown
      ? (JSON.parse(row.score_breakdown as string) as ScoreBreakdown)
      : null,
  } as Application;
}

// ─── Audit logging ──────────────────────────────────────────────────────────

export function logAuditEvent(
  applicationId: string,
  eventType: string,
  fromStatus: ApplicationStatus | null,
  toStatus: ApplicationStatus | null,
  metadata: Record<string, unknown> | null = null
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_log (id, application_id, event_type, from_status, to_status, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    applicationId,
    eventType,
    fromStatus,
    toStatus,
    metadata ? JSON.stringify(metadata) : null,
    new Date().toISOString()
  );
}

// ─── State transition helper ─────────────────────────────────────────────────

export function transitionStatus(
  applicationId: string,
  from: ApplicationStatus,
  to: ApplicationStatus,
  extra: Record<string, unknown> = {}
): Application {
  assertValidTransition(applicationId, from, to);

  const db = getDb();
  const now = new Date().toISOString();

  const setClauses = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [to, now];

  for (const [key, val] of Object.entries(extra)) {
    setClauses.push(`${key} = ?`);
    values.push(val);
  }

  values.push(applicationId);

  db.prepare(
    `UPDATE applications SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...values);

  logAuditEvent(applicationId, 'status_transition', from, to);

  return getApplicationById(applicationId);
}

// ─── Duplicate detection ─────────────────────────────────────────────────────

function findDuplicate(email: string, loanAmount: number): Application | null {
  const db = getDb();
  const windowMs = config.duplicate.windowMinutes * 60 * 1000;
  const cutoff = new Date(Date.now() - windowMs).toISOString();

  const row = db
    .prepare(
      `SELECT * FROM applications
       WHERE email = ? AND loan_amount = ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(email, loanAmount, cutoff) as Record<string, unknown> | undefined;

  return row ? rowToApplication(row) : null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function submitApplication(input: ApplicationInput): Application {
  // Validation
  if (!input.email || !input.applicant_name) {
    throw new ValidationError('email', 'applicant_name and email are required');
  }
  if (!input.loan_amount || input.loan_amount <= 0) {
    throw new ValidationError('loan_amount', 'loan_amount must be a positive number');
  }
  if (!['employed', 'self-employed', 'unemployed'].includes(input.employment_status)) {
    throw new ValidationError(
      'employment_status',
      'employment_status must be employed, self-employed, or unemployed'
    );
  }

  // Duplicate check
  const duplicate = findDuplicate(input.email, input.loan_amount);
  if (duplicate) {
    throw new DuplicateApplicationError(duplicate.id, input.email, input.loan_amount);
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Insert in 'submitted' state
  db.prepare(
    `INSERT INTO applications (
      id, applicant_name, email, loan_amount, stated_monthly_income, employment_status,
      documented_monthly_income, bank_ending_balance, bank_has_overdrafts,
      bank_has_consistent_deposits, monthly_withdrawals, monthly_deposits,
      status, retry_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 0, ?, ?)`
  ).run(
    id,
    input.applicant_name,
    input.email,
    input.loan_amount,
    input.stated_monthly_income,
    input.employment_status,
    input.documented_monthly_income ?? null,
    input.bank_ending_balance ?? null,
    input.bank_has_overdrafts === null ? null : input.bank_has_overdrafts ? 1 : 0,
    input.bank_has_consistent_deposits === null
      ? null
      : input.bank_has_consistent_deposits ? 1 : 0,
    input.monthly_withdrawals ?? null,
    input.monthly_deposits ?? null,
    now,
    now
  );

  logAuditEvent(id, 'application_submitted', null, ApplicationStatus.Submitted);

  // submitted → processing
  transitionStatus(id, ApplicationStatus.Submitted, ApplicationStatus.Processing);

  // Run scoring
  const breakdown = scoreApplication(input);
  const decision = decideFromScore(breakdown.total);
  const toStatus =
    decision === 'approved'
      ? ApplicationStatus.Approved
      : decision === 'denied'
        ? ApplicationStatus.Denied
        : ApplicationStatus.FlaggedForReview;

  // processing → approved | denied | flagged_for_review
  const app = transitionStatus(id, ApplicationStatus.Processing, toStatus, {
    score: breakdown.total,
    score_breakdown: JSON.stringify(breakdown),
  });

  logAuditEvent(id, 'scoring_complete', null, null, {
    score: breakdown.total,
    breakdown,
    decision,
  });

  // If approved, queue disbursement immediately
  if (toStatus === ApplicationStatus.Approved) {
    return transitionStatus(id, ApplicationStatus.Approved, ApplicationStatus.DisbursementQueued, {
      disbursement_queued_at: new Date().toISOString(),
    });
  }

  return app;
}

export function getApplicationById(id: string): Application {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;

  if (!row) throw new ApplicationNotFoundError(id);
  return rowToApplication(row);
}

export function listApplications(status?: string): Application[] {
  const db = getDb();
  const rows = status
    ? (db.prepare('SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC').all(status) as Record<string, unknown>[])
    : (db.prepare('SELECT * FROM applications ORDER BY created_at DESC').all() as Record<string, unknown>[]);

  return rows.map(rowToApplication);
}

export function getAuditLog(applicationId: string): unknown[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM audit_log WHERE application_id = ? ORDER BY created_at ASC')
    .all(applicationId);
}

export function adminReview(
  applicationId: string,
  decision: 'approved' | 'denied' | 'partially_approved',
  note: string | undefined,
  approvedLoanAmount: number | undefined
): Application {
  const app = getApplicationById(applicationId);

  if (app.status !== ApplicationStatus.FlaggedForReview) {
    throw new Error(
      `Admin review only applies to flagged_for_review applications. ` +
      `Current status: ${app.status}`
    );
  }

  if (decision === 'partially_approved') {
    if (!approvedLoanAmount || approvedLoanAmount <= 0) {
      throw new ValidationError(
        'approved_loan_amount',
        'approved_loan_amount is required and must be positive for partially_approved decision'
      );
    }
    if (approvedLoanAmount >= app.loan_amount) {
      throw new ValidationError(
        'approved_loan_amount',
        'approved_loan_amount must be less than the original loan_amount for partially_approved'
      );
    }
  }

  const toStatus =
    decision === 'approved'
      ? ApplicationStatus.Approved
      : decision === 'denied'
        ? ApplicationStatus.Denied
        : ApplicationStatus.PartiallyApproved;

  const extra: Record<string, unknown> = { review_note: note ?? null };
  if (decision === 'partially_approved') {
    extra.approved_loan_amount = approvedLoanAmount;
  }

  logAuditEvent(applicationId, 'admin_review', ApplicationStatus.FlaggedForReview, toStatus, {
    decision,
    note: note ?? null,
    approved_loan_amount: approvedLoanAmount ?? null,
  });

  const updated = transitionStatus(
    applicationId,
    ApplicationStatus.FlaggedForReview,
    toStatus,
    extra
  );

  // Queue disbursement for approved or partially_approved
  if (toStatus === ApplicationStatus.Approved || toStatus === ApplicationStatus.PartiallyApproved) {
    return transitionStatus(applicationId, toStatus, ApplicationStatus.DisbursementQueued, {
      disbursement_queued_at: new Date().toISOString(),
    });
  }

  return updated;
}

/**
 * Background job: escalate applications whose disbursement webhook never
 * arrived within the configured timeout window.
 */
export function escalateTimedOutDisbursements(): void {
  const db = getDb();
  const timeoutMs = config.disbursement.timeoutMinutes * 60 * 1000;
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const rows = db
    .prepare(
      `SELECT * FROM applications
       WHERE status = 'disbursement_queued' AND disbursement_queued_at < ?`
    )
    .all(cutoff) as Record<string, unknown>[];

  for (const row of rows) {
    const app = rowToApplication(row);
    try {
      transitionStatus(
        app.id,
        ApplicationStatus.DisbursementQueued,
        ApplicationStatus.FlaggedForReview
      );
      logAuditEvent(app.id, 'disbursement_timeout', ApplicationStatus.DisbursementQueued, ApplicationStatus.FlaggedForReview, {
        reason: 'No webhook received within timeout window',
        timeout_minutes: config.disbursement.timeoutMinutes,
      });
    } catch (err) {
      console.error(`Failed to escalate timed-out disbursement for ${app.id}:`, err);
    }
  }
}
