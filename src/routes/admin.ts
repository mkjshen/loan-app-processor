import { Router, Request, Response, NextFunction } from 'express';
import { basicAuth } from '../middleware/auth';
import {
  listApplications,
  getApplicationById,
  getAuditLog,
  adminReview,
} from '../services/applicationService';
import { ReviewDecision } from '../models/types';

const router = Router();

// All admin routes require basic auth
router.use(basicAuth);

/**
 * GET /admin/applications?status=flagged_for_review
 * List all applications, optionally filtered by status.
 */
router.get('/applications', (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const applications = listApplications(status);
    res.json({ applications, count: applications.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/applications/:id
 * Full detail including score breakdown and audit log.
 */
router.get('/applications/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const application = getApplicationById(req.params.id);
    const audit_log = getAuditLog(req.params.id);
    res.json({ application, audit_log });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/applications/:id/review
 * Approve, deny, or partially approve a flagged application.
 *
 * Body: { decision: 'approved'|'denied'|'partially_approved', note?: string, approved_loan_amount?: number }
 *
 * partially_approved requires approved_loan_amount < original loan_amount.
 * Approved/partially_approved automatically queue disbursement.
 */
router.post('/applications/:id/review', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { decision, note, approved_loan_amount } = req.body as ReviewDecision & {
      approved_loan_amount?: number;
    };

    if (!decision || !['approved', 'denied', 'partially_approved'].includes(decision)) {
      res.status(400).json({
        error: 'ValidationError',
        message: "decision must be 'approved', 'denied', or 'partially_approved'",
      });
      return;
    }

    const application = adminReview(req.params.id, decision, note, approved_loan_amount);
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

export default router;
