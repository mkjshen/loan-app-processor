import express from 'express';
import { config } from './config';
import { getDb } from './db';
import { escalateTimedOutDisbursements } from './services/applicationService';
import { errorHandler } from './middleware/errorHandler';
import applicationsRouter from './routes/applications';
import webhookRouter from './routes/webhook';
import adminRouter from './routes/admin';

const app = express();

app.use(express.json());

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/applications', applicationsRouter);
app.use('/webhook', webhookRouter);
app.use('/admin', adminRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ────────────────────────────────────────────────────────────────
function start(): void {
  // Initialize DB (runs migrations)
  getDb();

  // Background job: escalate disbursements that never received a webhook
  const interval = setInterval(() => {
    try {
      escalateTimedOutDisbursements();
    } catch (err) {
      console.error('Error in disbursement timeout job:', err);
    }
  }, config.disbursement.timeoutCheckIntervalMs);

  // Don't block process exit
  interval.unref();

  app.listen(config.port, () => {
    console.log(`Loan Application Processor running on http://localhost:${config.port}`);
    console.log(`Admin credentials: ${config.admin.username} / ${config.admin.password}`);
    console.log(`Disbursement timeout: ${config.disbursement.timeoutMinutes} minutes`);
  });
}

start();

export default app;
