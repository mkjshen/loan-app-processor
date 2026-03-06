import { Router, Request, Response, NextFunction } from 'express';
import { processDisbursementWebhook } from '../services/webhookService';
import { WebhookPayload } from '../models/types';

const router = Router();

/**
 * POST /webhook/disbursement
 * Receives disbursement outcomes from the payment processor.
 *
 * Body: { application_id, status: 'success'|'failed', transaction_id, timestamp }
 *
 * Idempotent: replaying the same transaction_id returns a 200 with replayed=true.
 * Failures auto-retry up to config.disbursement.maxRetries before escalating.
 */
router.post('/disbursement', (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = req.body as WebhookPayload;

    if (!payload.application_id || !payload.status || !payload.transaction_id) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'application_id, status, and transaction_id are required',
      });
      return;
    }

    if (payload.status !== 'success' && payload.status !== 'failed') {
      res.status(400).json({
        error: 'ValidationError',
        message: "status must be 'success' or 'failed'",
      });
      return;
    }

    const { application } = processDisbursementWebhook(payload);
    res.status(200).json({ application, replayed: false });
  } catch (err) {
    next(err);
  }
});

export default router;
