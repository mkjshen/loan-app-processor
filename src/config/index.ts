export const config = {
  port: 3000,

  scoring: {
    weights: {
      incomeVerification: 0.30,
      incomeLevel: 0.25,
      accountStability: 0.20,
      employmentStatus: 0.15,
      debtToIncome: 0.10,
    },
    // Interpretation: ±10% symmetric around stated income.
    // |documented - stated| / stated <= 0.10 to pass.
    // Rationale: lending risk is symmetric — both understating and
    // overstating income relative to documentation is suspicious.
    incomeTolerance: 0.10,
    // Income level: conservative income (lower of stated vs documented)
    // must be >= this multiple of the loan amount for full points.
    incomeLevelMultiple: 3,
    thresholds: {
      autoApprove: 75,   // score >= 75 → auto-approve
      manualReview: 50,  // score >= 50 → flag for review; < 50 → deny
    },
  },

  disbursement: {
    maxRetries: 3,
    // How long to wait for a webhook before escalating to manual review
    timeoutMinutes: 1440, // 24 hours
    // How often to poll for timed-out disbursements
    timeoutCheckIntervalMs: 60_000, // every minute
  },

  duplicate: {
    windowMinutes: 5, // same email + loan_amount within this window = duplicate
  },

  admin: {
    username: 'admin',
    password: 'password',
  },
};
