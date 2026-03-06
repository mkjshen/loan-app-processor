import { config } from '../config';
import { ApplicationInput, ScoreBreakdown } from '../models/types';

const { weights, incomeTolerance, incomeLevelMultiple, thresholds } = config.scoring;

/**
 * Scores an income verification factor (0 or 100).
 *
 * Interpretation: "10% tolerance" means symmetric: the absolute percentage
 * difference between documented and stated income must be <= 10%.
 * Formula: |documented - stated| / stated <= 0.10
 *
 * Rationale: Both directions of mismatch are red flags. A borrower with
 * documented income 15% ABOVE stated may have irregular income or clerical
 * errors. A borrower with documented income 15% BELOW stated is overstating.
 * Symmetric tolerance catches both cases fairly.
 *
 * null documented_monthly_income → 0 points (unverifiable = fail).
 */
function scoreIncomeVerification(input: ApplicationInput): number {
  if (input.documented_monthly_income === null) return 0;
  const diff = Math.abs(input.documented_monthly_income - input.stated_monthly_income);
  const pct = diff / input.stated_monthly_income;
  return pct <= incomeTolerance ? 100 : 0;
}

/**
 * Scores income level relative to loan amount (0 or 100, binary).
 *
 * Uses the CONSERVATIVE income: lower of stated vs documented (if documented
 * is available). This prevents applicants from gaming the income level check
 * by overstating income when documentation shows a lower figure.
 *
 * Threshold: conservative_income >= incomeLevelMultiple * loan_amount
 */
function scoreIncomeLevel(input: ApplicationInput): number {
  const effectiveIncome =
    input.documented_monthly_income !== null
      ? Math.min(input.stated_monthly_income, input.documented_monthly_income)
      : input.stated_monthly_income;

  return effectiveIncome >= incomeLevelMultiple * input.loan_amount ? 100 : 0;
}

/**
 * Scores account stability (0–100) across three equally-weighted sub-factors:
 * - Positive ending balance
 * - No overdrafts
 * - Consistent deposits
 *
 * Null values are treated as NEUTRAL (50% of sub-factor points) rather than
 * zero. Missing documentation is not evidence of a problem, but it prevents
 * full credit — hence the application needs manual review in ambiguous cases.
 */
function scoreAccountStability(input: ApplicationInput): number {
  const pointsPerFactor = 100 / 3;

  const balanceScore =
    input.bank_ending_balance === null
      ? pointsPerFactor * 0.5
      : input.bank_ending_balance > 0
        ? pointsPerFactor
        : 0;

  const overdraftScore =
    input.bank_has_overdrafts === null
      ? pointsPerFactor * 0.5
      : !input.bank_has_overdrafts
        ? pointsPerFactor
        : 0;

  const depositScore =
    input.bank_has_consistent_deposits === null
      ? pointsPerFactor * 0.5
      : input.bank_has_consistent_deposits
        ? pointsPerFactor
        : 0;

  return balanceScore + overdraftScore + depositScore;
}

/**
 * Scores employment status (0, 50, or 100).
 * employed > self-employed > unemployed
 */
function scoreEmploymentStatus(input: ApplicationInput): number {
  switch (input.employment_status) {
    case 'employed': return 100;
    case 'self-employed': return 50;
    case 'unemployed': return 0;
    default: return 0;
  }
}

/**
 * Scores debt-to-income ratio using a continuous scale.
 * ratio = monthly_withdrawals / monthly_deposits (proxy for obligations)
 * score = max(0, (1 - ratio) * 100) — linear penalty as withdrawals grow.
 *
 * Null deposits/withdrawals → 50 (neutral, missing data).
 * ratio > 1 → 0 (spending more than earning is the worst case).
 */
function scoreDti(input: ApplicationInput): number {
  if (input.monthly_deposits === null || input.monthly_withdrawals === null) {
    return 50; // neutral
  }
  if (input.monthly_deposits === 0) return 0;
  const ratio = input.monthly_withdrawals / input.monthly_deposits;
  return Math.max(0, Math.min(100, (1 - ratio) * 100));
}

export function scoreApplication(input: ApplicationInput): ScoreBreakdown {
  const { weights: w } = config.scoring;

  const iv = scoreIncomeVerification(input);
  const il = scoreIncomeLevel(input);
  const as_ = scoreAccountStability(input);
  const es = scoreEmploymentStatus(input);
  const dti = scoreDti(input);

  const total =
    iv * w.incomeVerification +
    il * w.incomeLevel +
    as_ * w.accountStability +
    es * w.employmentStatus +
    dti * w.debtToIncome;

  return {
    incomeVerification: Math.round(iv * 100) / 100,
    incomeLevel: Math.round(il * 100) / 100,
    accountStability: Math.round(as_ * 100) / 100,
    employmentStatus: Math.round(es * 100) / 100,
    debtToIncome: Math.round(dti * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

export function decideFromScore(score: number): 'approved' | 'denied' | 'flagged_for_review' {
  if (score >= thresholds.autoApprove) return 'approved';
  if (score >= thresholds.manualReview) return 'flagged_for_review';
  return 'denied';
}
