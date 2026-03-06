export enum ApplicationStatus {
  Submitted = 'submitted',
  Processing = 'processing',
  Approved = 'approved',
  Denied = 'denied',
  FlaggedForReview = 'flagged_for_review',
  PartiallyApproved = 'partially_approved',
  DisbursementQueued = 'disbursement_queued',
  Disbursed = 'disbursed',
  DisbursementFailed = 'disbursement_failed',
}

export interface ApplicationInput {
  applicant_name: string;
  email: string;
  loan_amount: number;
  stated_monthly_income: number;
  employment_status: 'employed' | 'self-employed' | 'unemployed';
  documented_monthly_income: number | null;
  bank_ending_balance: number | null;
  bank_has_overdrafts: boolean | null;
  bank_has_consistent_deposits: boolean | null;
  monthly_withdrawals: number | null;
  monthly_deposits: number | null;
}

export interface ScoreBreakdown {
  incomeVerification: number;
  incomeLevel: number;
  accountStability: number;
  employmentStatus: number;
  debtToIncome: number;
  total: number;
}

export interface Application {
  id: string;
  applicant_name: string;
  email: string;
  loan_amount: number;
  stated_monthly_income: number;
  employment_status: string;
  documented_monthly_income: number | null;
  bank_ending_balance: number | null;
  bank_has_overdrafts: boolean | null;
  bank_has_consistent_deposits: boolean | null;
  monthly_withdrawals: number | null;
  monthly_deposits: number | null;
  status: ApplicationStatus;
  score: number | null;
  score_breakdown: ScoreBreakdown | null;
  approved_loan_amount: number | null;
  review_note: string | null;
  retry_count: number;
  disbursement_queued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  application_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface WebhookPayload {
  application_id: string;
  status: 'success' | 'failed';
  transaction_id: string;
  timestamp: string;
}

export interface ReviewDecision {
  decision: 'approved' | 'denied' | 'partially_approved';
  note?: string;
  approved_loan_amount?: number; // required for partially_approved
}
