import { ApplicationStatus } from '../models/types';

export class InvalidStateTransitionError extends Error {
  readonly name = 'InvalidStateTransitionError';
  readonly from: ApplicationStatus;
  readonly to: ApplicationStatus;
  readonly applicationId: string;

  constructor(applicationId: string, from: ApplicationStatus, to: ApplicationStatus) {
    super(`Invalid state transition for application ${applicationId}: ${from} → ${to}`);
    this.applicationId = applicationId;
    this.from = from;
    this.to = to;
  }
}

export class DuplicateApplicationError extends Error {
  readonly name = 'DuplicateApplicationError';
  readonly originalApplicationId: string;

  constructor(originalApplicationId: string, email: string, loanAmount: number) {
    super(
      `Duplicate application detected for ${email} with loan amount $${loanAmount}. ` +
      `Original application ID: ${originalApplicationId}`
    );
    this.originalApplicationId = originalApplicationId;
  }
}

export class WebhookReplayError extends Error {
  readonly name = 'WebhookReplayError';
  readonly transactionId: string;
  readonly originalApplicationId: string;

  constructor(transactionId: string, originalApplicationId: string) {
    super(
      `Webhook with transaction_id ${transactionId} has already been processed ` +
      `for application ${originalApplicationId}`
    );
    this.transactionId = transactionId;
    this.originalApplicationId = originalApplicationId;
  }
}

export class ApplicationNotFoundError extends Error {
  readonly name = 'ApplicationNotFoundError';
  readonly applicationId: string;

  constructor(applicationId: string) {
    super(`Application not found: ${applicationId}`);
    this.applicationId = applicationId;
  }
}

export class ValidationError extends Error {
  readonly name = 'ValidationError';
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}
