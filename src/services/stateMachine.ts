import { ApplicationStatus } from '../models/types';
import { InvalidStateTransitionError } from '../errors';

/**
 * Exhaustive map of valid state transitions.
 *
 * Design: transitions are strict — anything not listed here is rejected.
 * This makes the state machine easy to audit and extend safely.
 *
 * Mid-spec migration note (partially_approved):
 * Added as a first-class state alongside approved/denied.
 * - Reachable from flagged_for_review (admin decision on 50–74 scored apps)
 * - Leads to disbursement_queued with a reduced loan amount
 * - Does NOT break any existing transition paths
 */
const VALID_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  [ApplicationStatus.Submitted]: [ApplicationStatus.Processing],

  [ApplicationStatus.Processing]: [
    ApplicationStatus.Approved,
    ApplicationStatus.Denied,
    ApplicationStatus.FlaggedForReview,
  ],

  [ApplicationStatus.Approved]: [ApplicationStatus.DisbursementQueued],

  [ApplicationStatus.Denied]: [], // terminal

  [ApplicationStatus.FlaggedForReview]: [
    ApplicationStatus.Approved,
    ApplicationStatus.Denied,
    ApplicationStatus.PartiallyApproved, // mid-spec migration
  ],

  [ApplicationStatus.PartiallyApproved]: [ApplicationStatus.DisbursementQueued],

  [ApplicationStatus.DisbursementQueued]: [
    ApplicationStatus.Disbursed,
    ApplicationStatus.DisbursementFailed,
  ],

  [ApplicationStatus.Disbursed]: [], // terminal

  [ApplicationStatus.DisbursementFailed]: [
    ApplicationStatus.DisbursementQueued, // retry
    ApplicationStatus.FlaggedForReview,   // max retries exceeded
  ],
};

/**
 * Validates and asserts that a transition is legal.
 * Throws InvalidStateTransitionError if not — never returns undefined.
 */
export function assertValidTransition(
  applicationId: string,
  from: ApplicationStatus,
  to: ApplicationStatus
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(applicationId, from, to);
  }
}

export function getValidTransitions(from: ApplicationStatus): readonly ApplicationStatus[] {
  return VALID_TRANSITIONS[from];
}
