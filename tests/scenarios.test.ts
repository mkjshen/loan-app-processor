import request from 'supertest';
import path from 'path';
import fs from 'fs';

// Use a test-specific DB so tests don't pollute production data
const TEST_DB = path.join(process.cwd(), 'test.db');
process.env['DB_PATH'] = TEST_DB;

import app from '../src/app';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const post = (url: string, body: object) =>
  request(app).post(url).send(body).set('Content-Type', 'application/json');

const postAdmin = (url: string, body: object) =>
  request(app)
    .post(url)
    .send(body)
    .set('Content-Type', 'application/json')
    .set('Authorization', 'Basic ' + Buffer.from('admin:password').toString('base64'));

const getAdmin = (url: string) =>
  request(app)
    .get(url)
    .set('Authorization', 'Basic ' + Buffer.from('admin:password').toString('base64'));

const webhook = (body: object) => post('/webhook/disbursement', body);

const txnId = () => 'txn_' + Math.random().toString(36).slice(2) + '_' + Date.now();

// Scenario inputs from the spec
const JANE_STRONG = {
  applicant_name: 'Jane Doe',
  email: 'jane.doe@example.com',
  loan_amount: 1500,
  stated_monthly_income: 5000,
  employment_status: 'employed',
  documented_monthly_income: 4800,
  bank_ending_balance: 3200,
  bank_has_overdrafts: false,
  bank_has_consistent_deposits: true,
  monthly_withdrawals: 1200,
  monthly_deposits: 4800,
};

const BOB_WEAK = {
  applicant_name: 'Bob Smith',
  email: 'bob.smith@example.com',
  loan_amount: 2000,
  stated_monthly_income: 1400,
  employment_status: 'self-employed',
  documented_monthly_income: 1350,
  bank_ending_balance: 150,
  bank_has_overdrafts: true,
  bank_has_consistent_deposits: false,
  monthly_withdrawals: 1100,
  monthly_deposits: 1350,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

// ─── Scenario 1: Jane Doe $1,500 — Auto-approve ───────────────────────────────

describe('Scenario 1 — Auto-approve (strong financials)', () => {
  let appId: string;

  it('submits and auto-approves into disbursement_queued', async () => {
    const res = await post('/applications', JANE_STRONG);
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('disbursement_queued');
    expect(application.score).toBeGreaterThanOrEqual(75);
    appId = application.id;
  });

  it('score breakdown sums to total', async () => {
    const res = await getAdmin(`/admin/applications/${appId}`);
    const { score_breakdown } = res.body.application;
    const sumOfWeighted =
      score_breakdown.incomeVerification * 0.3 +
      score_breakdown.incomeLevel * 0.25 +
      score_breakdown.accountStability * 0.2 +
      score_breakdown.employmentStatus * 0.15 +
      score_breakdown.debtToIncome * 0.1;
    expect(Math.abs(sumOfWeighted - score_breakdown.total)).toBeLessThan(0.01);
  });

  it('happy path: webhook success → disbursed', async () => {
    const res = await webhook({
      application_id: appId,
      status: 'success',
      transaction_id: txnId(),
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('disbursed');
  });
});

// ─── Scenario 2: Bob Smith $2,000 — Auto-deny ────────────────────────────────

describe('Scenario 2 — Auto-deny (weak financials, large loan)', () => {
  it('submits and auto-denies', async () => {
    const res = await post('/applications', BOB_WEAK);
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('denied');
    expect(application.score).toBeLessThan(50);
  });
});

// ─── Scenario 3: Bob Smith $300 — Flag for review ────────────────────────────

describe('Scenario 3 — Flag for review (weak financials, small loan)', () => {
  let appId: string;

  it('submits and flags for review', async () => {
    const res = await post('/applications', { ...BOB_WEAK, email: 'bob.s3@example.com', loan_amount: 300 });
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('flagged_for_review');
    expect(application.score).toBeGreaterThanOrEqual(50);
    expect(application.score).toBeLessThan(75);
    appId = application.id;
  });

  it('appears in admin flagged list', async () => {
    const res = await getAdmin('/admin/applications?status=flagged_for_review');
    expect(res.status).toBe(200);
    const ids = res.body.applications.map((a: { id: string }) => a.id);
    expect(ids).toContain(appId);
  });
});

// ─── Scenario 4: Jane Doe $4,500 — Flag for review ───────────────────────────

describe('Scenario 4 — Flag for review (strong finances, large loan)', () => {
  it('flags for review because income < 3x loan', async () => {
    const res = await post('/applications', {
      ...JANE_STRONG,
      email: 'jane.s4@example.com',
      loan_amount: 4500,
    });
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('flagged_for_review');
    expect(application.score).toBeGreaterThanOrEqual(50);
    expect(application.score).toBeLessThan(75);
    // Income level should be 0: 4800 / 4500 = 1.07x, below 3x threshold
    expect(application.score_breakdown.incomeLevel).toBe(0);
  });
});

// ─── Scenario 5: Carol Tester $1,000 — No documents ─────────────────────────

describe('Scenario 5 — Flag for review (no documentation)', () => {
  it('flags for review when all bank/doc fields are null', async () => {
    const res = await post('/applications', {
      applicant_name: 'Carol Tester',
      email: 'carol.tester@example.com',
      loan_amount: 1000,
      stated_monthly_income: 8000,
      employment_status: 'employed',
      documented_monthly_income: null,
      bank_ending_balance: null,
      bank_has_overdrafts: null,
      bank_has_consistent_deposits: null,
      monthly_withdrawals: null,
      monthly_deposits: null,
    });
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('flagged_for_review');
    // Income verification must be 0 — no documented income
    expect(application.score_breakdown.incomeVerification).toBe(0);
  });
});

// ─── Scenario 6: Dave Liar $2,000 — Auto-deny ────────────────────────────────

describe('Scenario 6 — Auto-deny (stated vs documented income mismatch)', () => {
  it('auto-denies when documented income is far below stated', async () => {
    const res = await post('/applications', {
      applicant_name: 'Dave Liar',
      email: 'dave.liar@example.com',
      loan_amount: 2000,
      stated_monthly_income: 10000,
      employment_status: 'employed',
      documented_monthly_income: 1400,
      bank_ending_balance: 150,
      bank_has_overdrafts: true,
      bank_has_consistent_deposits: false,
      monthly_withdrawals: 1100,
      monthly_deposits: 1400,
    });
    expect(res.status).toBe(201);
    const { application } = res.body;
    expect(application.status).toBe('denied');
    expect(application.score).toBeLessThan(50);
    // Income verification must be 0 — 86% mismatch, far outside ±10%
    expect(application.score_breakdown.incomeVerification).toBe(0);
    // Income level must be 0 — conservative income 1400 / 2000 = 0.7x
    expect(application.score_breakdown.incomeLevel).toBe(0);
  });
});

// ─── Scenario 7: Duplicate rejection ─────────────────────────────────────────

describe('Scenario 7 — Duplicate submission rejected', () => {
  it('rejects a duplicate within the time window', async () => {
    // First submission
    const first = await post('/applications', {
      ...JANE_STRONG,
      email: 'jane.dup@example.com',
    });
    expect(first.status).toBe(201);
    const originalId = first.body.application.id;

    // Immediate re-submission — same email + loan_amount
    const second = await post('/applications', {
      ...JANE_STRONG,
      email: 'jane.dup@example.com',
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('DuplicateApplicationError');
    expect(second.body.original_application_id).toBe(originalId);
  });

  it('allows resubmission with a different loan amount', async () => {
    await post('/applications', { ...JANE_STRONG, email: 'jane.diff@example.com' });
    const res = await post('/applications', {
      ...JANE_STRONG,
      email: 'jane.diff@example.com',
      loan_amount: 999, // different amount — not a duplicate
    });
    expect(res.status).toBe(201);
  });
});

// ─── Scenario 8: Webhook replay idempotency ───────────────────────────────────

describe('Scenario 8 — Webhook replay idempotency', () => {
  let appId: string;
  const tid = txnId();

  beforeAll(async () => {
    const res = await post('/applications', { ...JANE_STRONG, email: 'jane.replay@example.com' });
    appId = res.body.application.id;
  });

  it('first webhook processes normally', async () => {
    const res = await webhook({ application_id: appId, status: 'success', transaction_id: tid, timestamp: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('disbursed');
    expect(res.body.replayed).toBe(false);
  });

  it('replayed webhook returns 200 with WebhookReplayError (no state change)', async () => {
    const res = await webhook({ application_id: appId, status: 'success', transaction_id: tid, timestamp: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('replayed');
    expect(res.body.error).toBe('WebhookReplayError');
    expect(res.body.transaction_id).toBe(tid);
  });
});

// ─── State machine enforcement ────────────────────────────────────────────────

describe('State machine enforcement', () => {
  it('rejects webhook on a denied application', async () => {
    const res = await post('/applications', { ...BOB_WEAK, email: 'bob.sm@example.com' });
    const deniedId = res.body.application.id;
    expect(res.body.application.status).toBe('denied');

    const wh = await webhook({ application_id: deniedId, status: 'success', transaction_id: txnId(), timestamp: new Date().toISOString() });
    expect(wh.status).toBe(500); // denied → disbursement_queued is not valid
  });

  it('rejects admin review on a non-flagged application', async () => {
    const res = await post('/applications', { ...JANE_STRONG, email: 'jane.sm@example.com' });
    const approvedId = res.body.application.id; // already in disbursement_queued

    const review = await postAdmin(`/admin/applications/${approvedId}/review`, { decision: 'approved' });
    expect(review.status).toBe(500); // only flagged_for_review can be reviewed
  });

  it('returns 404 for unknown application', async () => {
    const res = await getAdmin('/admin/applications/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ApplicationNotFoundError');
  });
});

// ─── partially_approved state ─────────────────────────────────────────────────

describe('partially_approved — mid-spec migration', () => {
  let flaggedId: string;

  beforeAll(async () => {
    const res = await post('/applications', { ...BOB_WEAK, email: 'bob.partial@example.com', loan_amount: 300 });
    flaggedId = res.body.application.id;
    expect(res.body.application.status).toBe('flagged_for_review');
  });

  it('admin can partially approve with a reduced loan amount', async () => {
    const res = await postAdmin(`/admin/applications/${flaggedId}/review`, {
      decision: 'partially_approved',
      note: 'Approved at half the requested amount',
      approved_loan_amount: 150,
    });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('disbursement_queued');
    expect(res.body.application.approved_loan_amount).toBe(150);
  });

  it('partially_approved audit trail shows the full transition path', async () => {
    const res = await getAdmin(`/admin/applications/${flaggedId}`);
    const events = res.body.audit_log.map((e: { event_type: string }) => e.event_type);
    expect(events).toContain('admin_review');
    const transitions = res.body.audit_log
      .filter((e: { event_type: string }) => e.event_type === 'status_transition')
      .map((e: { to_status: string }) => e.to_status);
    expect(transitions).toContain('partially_approved');
    expect(transitions).toContain('disbursement_queued');
  });

  it('rejects partially_approved without approved_loan_amount', async () => {
    const res2 = await post('/applications', { ...BOB_WEAK, email: 'bob.partial2@example.com', loan_amount: 300 });
    const res = await postAdmin(`/admin/applications/${res2.body.application.id}/review`, {
      decision: 'partially_approved',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });
});

// ─── Webhook retry + audit trail ─────────────────────────────────────────────

describe('Webhook retry flow — failure retries with unique audit records', () => {
  let appId: string;

  beforeAll(async () => {
    const res = await post('/applications', { ...JANE_STRONG, email: 'jane.retry@example.com' });
    appId = res.body.application.id;
  });

  it('failure 1: re-queues for retry (retry_count = 1)', async () => {
    const res = await webhook({ application_id: appId, status: 'failed', transaction_id: txnId(), timestamp: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('disbursement_queued');
    expect(res.body.application.retry_count).toBe(1);
  });

  it('failure 2: re-queues for retry (retry_count = 2)', async () => {
    const res = await webhook({ application_id: appId, status: 'failed', transaction_id: txnId(), timestamp: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('disbursement_queued');
    expect(res.body.application.retry_count).toBe(2);
  });

  it('failure 3: max retries exceeded → escalates to flagged_for_review', async () => {
    const res = await webhook({ application_id: appId, status: 'failed', transaction_id: txnId(), timestamp: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('flagged_for_review');
  });

  it('each failure produces a unique retry_id in the audit log', async () => {
    const res = await getAdmin(`/admin/applications/${appId}`);
    const failureEvents = res.body.audit_log.filter(
      (e: { event_type: string }) => e.event_type === 'disbursement_failure'
    );
    expect(failureEvents).toHaveLength(3);
    const retryIds = failureEvents.map((e: { metadata: string }) => JSON.parse(e.metadata).retry_id);
    const unique = new Set(retryIds);
    expect(unique.size).toBe(3); // all 3 retry_ids are distinct
  });
});

// ─── Admin auth ────────────────────────────────────────────────────────────────

describe('Admin authentication', () => {
  it('returns 401 with no credentials', async () => {
    const res = await request(app).get('/admin/applications');
    expect(res.status).toBe(401);
  });

  it('returns 403 with wrong credentials', async () => {
    const res = await request(app)
      .get('/admin/applications')
      .set('Authorization', 'Basic ' + Buffer.from('admin:wrong').toString('base64'));
    expect(res.status).toBe(403);
  });

  it('returns 200 with correct credentials', async () => {
    const res = await getAdmin('/admin/applications');
    expect(res.status).toBe(200);
  });
});
