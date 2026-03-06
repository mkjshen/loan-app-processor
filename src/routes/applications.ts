import { Router, Request, Response, NextFunction } from 'express';
import { submitApplication } from '../services/applicationService';
import { ApplicationInput } from '../models/types';

const router = Router();

/**
 * POST /applications
 * Submit a new loan application. Processing and scoring happen synchronously.
 * Returns the final application state (approved/denied/flagged_for_review/disbursement_queued).
 */
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = req.body as ApplicationInput;
    const application = submitApplication(input);
    res.status(201).json({ application });
  } catch (err) {
    next(err);
  }
});

export default router;
