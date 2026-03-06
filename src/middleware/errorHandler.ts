import { Request, Response, NextFunction } from 'express';
import {
  InvalidStateTransitionError,
  DuplicateApplicationError,
  WebhookReplayError,
  ApplicationNotFoundError,
  ValidationError,
} from '../errors';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof InvalidStateTransitionError) {
    res.status(409).json({
      error: err.name,
      message: err.message,
      application_id: err.applicationId,
      from: err.from,
      to: err.to,
    });
    return;
  }

  if (err instanceof DuplicateApplicationError) {
    res.status(409).json({
      error: err.name,
      message: err.message,
      original_application_id: err.originalApplicationId,
    });
    return;
  }

  if (err instanceof WebhookReplayError) {
    // Replays are not errors from the caller's perspective — return 200 with info
    res.status(200).json({
      status: 'replayed',
      error: err.name,
      message: err.message,
      transaction_id: err.transactionId,
      original_application_id: err.originalApplicationId,
    });
    return;
  }

  if (err instanceof ApplicationNotFoundError) {
    res.status(404).json({
      error: err.name,
      message: err.message,
      application_id: err.applicationId,
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(400).json({
      error: err.name,
      message: err.message,
      field: err.field,
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'InternalServerError',
    message: err.message,
  });
}
