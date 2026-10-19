// Typed, persisted model-job queue (V2 §11). One shared budget for every job type; each job records
// its inputs, cutoff, deadline and the moment its result became available. Dispatch is by priority,
// then earliest deadline, then arrival. A job past its deadline expires instead of running late.
import { db } from "./db";

export type JobType = "token_research" | "narrative_update" | "process_lesson" | "hypothesis_proposal" | "experiment_review";
export type JobStatus = "queued" | "running" | "done" | "failed" | "expired" | "skipped";

export type Job = {
  id: string;
  type: JobType;
  subject: string;
  priority: number;
  deadline: number;
  enqueuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  status: JobStatus;
  /** Latest evidence time the job may use; set when it starts. */
  inputCutoff: number | null;
  reportId: string | null;
  error: string | null;
  payload: Record<string, unknown>;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS research_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    priority REAL NOT NULL,
    deadline INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    status TEXT NOT NULL,
    input_cutoff INTEGER,
    report_id TEXT,
    error TEXT,
    payload TEXT NOT NULL,
    seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS research_jobs_status ON research_jobs (status, priority, deadline);
`);

const row = (r: Record<string, unknown>): Job => ({
  id: r.id as string,
  type: r.type as JobType,
  subject: r.subject as string,
  priority: r.priority as number,
  deadline: r.deadline as number,
  enqueuedAt: r.enqueued_at as number,
  startedAt: (r.started_at as number) ?? null,
  completedAt: (r.completed_at as number) ?? null,
  status: r.status as JobStatus,
  inputCutoff: (r.input_cutoff as number) ?? null,
  reportId: (r.report_id as string) ?? null,
  error: (r.error as string) ?? null,
  payload: JSON.parse(r.payload as string),
});

let seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM research_jobs").get() as { s: number }).s;

/** Adds a job, or raises the priority / extends the deadline of the open job for the same type and subject. */
export function enqueue(type: JobType, subject: string, priority: number, deadline: number, payload: Record<string, unknown> = {}, now = Date.now()): Job {
  const open = db.prepare("SELECT * FROM research_jobs WHERE type = ? AND subject = ? AND status IN ('queued', 'running')").get(type, subject) as
    | Record<string, unknown>
    | undefined;
  if (open) {
    if ((open.status as string) === "queued")
      db.prepare("UPDATE research_jobs SET priority = MAX(priority, ?), deadline = MAX(deadline, ?) WHERE id = ?").run(priority, deadline, open.id as string);
    return row(db.prepare("SELECT * FROM research_jobs WHERE id = ?").get(open.id as string) as Record<string, unknown>);
  }
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO research_jobs (id, type, subject, priority, deadline, enqueued_at, status, payload, seq) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
  ).run(id, type, subject, priority, deadline, now, JSON.stringify(payload), ++seq);
  return row(db.prepare("SELECT * FROM research_jobs WHERE id = ?").get(id) as Record<string, unknown>);
}

/** Expires overdue queued jobs, then returns the next one to run (or null). */
export function nextJob(now = Date.now()): Job | null {
  db.prepare("UPDATE research_jobs SET status = 'expired', completed_at = ? WHERE status = 'queued' AND deadline < ?").run(now, now);
  const r = db.prepare("SELECT * FROM research_jobs WHERE status = 'queued' ORDER BY priority DESC, deadline ASC, seq ASC LIMIT 1").get() as
    | Record<string, unknown>
    | undefined;
  return r ? row(r) : null;
}

export function startJob(id: string, inputCutoff: number, now = Date.now()) {
  db.prepare("UPDATE research_jobs SET status = 'running', started_at = ?, input_cutoff = ? WHERE id = ?").run(now, inputCutoff, id);
}
export function finishJob(id: string, status: "done" | "failed" | "skipped", detail: { reportId?: string; error?: string } = {}, now = Date.now()) {
  db.prepare("UPDATE research_jobs SET status = ?, completed_at = ?, report_id = ?, error = ? WHERE id = ?").run(
    status,
    now,
    detail.reportId ?? null,
    detail.error ?? null,
    id,
  );
}

/** Jobs left running by a crash are failed on restart (their result never became available). */
export function recoverJobs(now = Date.now()) {
  db.prepare("UPDATE research_jobs SET status = 'failed', completed_at = ?, error = 'interrupted by restart' WHERE status = 'running'").run(now);
}

export function jobsReport(sinceMs = 24 * 3600_000, now = Date.now()) {
  const rows = (db.prepare("SELECT * FROM research_jobs WHERE enqueued_at >= ?").all(now - sinceMs) as Record<string, unknown>[]).map(row);
  const by: Record<string, Record<string, number>> = {};
  for (const j of rows) {
    by[j.type] ??= {};
    by[j.type][j.status] = (by[j.type][j.status] ?? 0) + 1;
  }
  const waits = rows.filter((j) => j.startedAt).map((j) => j.startedAt! - j.enqueuedAt).sort((a, b) => a - b);
  const runs = rows.filter((j) => j.startedAt && j.completedAt && j.status === "done").map((j) => j.completedAt! - j.startedAt!).sort((a, b) => a - b);
  const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);
  return {
    byType: by,
    queued: rows.filter((j) => j.status === "queued").length,
    queueWaitMs: { p50: q(waits, 0.5), p95: q(waits, 0.95) },
    runMs: { p50: q(runs, 0.5), p95: q(runs, 0.95) },
    recent: rows.sort((a, b) => b.enqueuedAt - a.enqueuedAt).slice(0, 20),
  };
}
