import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env['DB_PATH'] ?? path.join(process.cwd(), 'loan_processor.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      applicant_name TEXT NOT NULL,
      email TEXT NOT NULL,
      loan_amount REAL NOT NULL,
      stated_monthly_income REAL NOT NULL,
      employment_status TEXT NOT NULL,
      documented_monthly_income REAL,
      bank_ending_balance REAL,
      bank_has_overdrafts INTEGER,
      bank_has_consistent_deposits INTEGER,
      monthly_withdrawals REAL,
      monthly_deposits REAL,
      status TEXT NOT NULL DEFAULT 'submitted',
      score REAL,
      score_breakdown TEXT,
      approved_loan_amount REAL,
      review_note TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      disbursement_queued_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications(id)
    );

    -- Idempotency table: tracks every processed webhook transaction_id.
    -- A replay of the same transaction_id returns the original result silently.
    CREATE TABLE IF NOT EXISTS processed_webhooks (
      transaction_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      webhook_status TEXT NOT NULL,
      result_status TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);
}
