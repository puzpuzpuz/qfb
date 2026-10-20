import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import type { PlanStep, RunConfig, StateName, GitSnapshot } from "./types.ts";

export interface RunRow {
  id: string;
  repoPath: string;
  branch: string;
  baseRef: string;
  designPath: string;
  designHash: string;
  config: RunConfig;
  state: StateName;
  approved: boolean;
  denyList: string[];
  stopReason: string | null;
  createdAt: string;
}

/**
 * Durable, transactional state store (Section 4.4). All state changes are
 * atomic. An exclusive run lock prevents two controller instances from
 * executing the same run concurrently (Section 15 / Section 4.4).
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL: concurrent readers + a serialized writer. busy_timeout: when parallel
    // runs (distinct run_ids) in the same shared DB attempt a write at the same
    // instant, wait up to 5s rather than failing fast with SQLITE_BUSY.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        design_path TEXT NOT NULL,
        design_hash TEXT NOT NULL,
        config_json TEXT NOT NULL,
        state TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        deny_list_json TEXT NOT NULL DEFAULT '[]',
        stop_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        operation TEXT NOT NULL,
        evidence TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pane_id TEXT,
        status TEXT,
        artifact_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        git_head TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        test_gate INTEGER NOT NULL,
        raw_path TEXT,
        candidate_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (run_id, key)
      );
      CREATE TABLE IF NOT EXISTS locks (
        run_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        host TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
  }

  now(): string {
    return new Date().toISOString();
  }

  // ---- Runs ----
  createRun(row: Omit<RunRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, repo_path, branch, base_ref, design_path, design_hash,
           config_json, state, approved, deny_list_json, stop_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.repoPath, row.branch, row.baseRef, row.designPath, row.designHash,
        JSON.stringify(row.config), row.state, row.approved ? 1 : 0,
        JSON.stringify(row.denyList), row.stopReason, this.now(),
      );
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      repoPath: r.repo_path as string,
      branch: r.branch as string,
      baseRef: r.base_ref as string,
      designPath: r.design_path as string,
      designHash: r.design_hash as string,
      config: JSON.parse(r.config_json as string) as RunConfig,
      state: r.state as StateName,
      approved: (r.approved as number) === 1,
      denyList: JSON.parse(r.deny_list_json as string) as string[],
      stopReason: (r.stop_reason as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  /**
   * Find the most recent run for a (repo, design, base) triple. `build` uses
   * this to resume an interrupted run instead of creating a duplicate.
   */
  findRun(repoPath: string, designPath: string, baseRef: string): RunRow | null {
    const r = this.db
      .prepare(
        "SELECT id FROM runs WHERE repo_path = ? AND design_path = ? AND base_ref = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(repoPath, designPath, baseRef) as { id: string } | undefined;
    return r ? this.getRun(r.id) : null;
  }

  listRuns(): RunRow[] {
    const rows = this.db.prepare("SELECT id FROM runs ORDER BY created_at DESC").all() as { id: string }[];
    return rows.map((r) => this.getRun(r.id)!).filter(Boolean);
  }

  setApproved(id: string): void {
    this.db.prepare("UPDATE runs SET approved = 1 WHERE id = ?").run(id);
  }

  setState(id: string, state: StateName): void {
    this.db.prepare("UPDATE runs SET state = ? WHERE id = ?").run(state, id);
  }

  setStopReason(id: string, reason: string | null): void {
    this.db.prepare("UPDATE runs SET stop_reason = ? WHERE id = ?").run(reason, id);
  }

  setDesignHash(id: string, hash: string): void {
    this.db.prepare("UPDATE runs SET design_hash = ? WHERE id = ?").run(hash, id);
  }

  // ---- Steps ----
  insertSteps(runId: string, steps: PlanStep[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO steps (run_id, id, ordinal, text, status, attempts) VALUES (?,?,?,?,?,0)",
    );
    const tx = this.db.prepare("BEGIN"); // simple transaction wrapper
    tx.run();
    try {
      for (const s of steps) stmt.run(runId, s.id, s.ordinal, s.text, s.status);
      this.db.prepare("COMMIT").run();
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  getSteps(runId: string): (PlanStep & { attempts: number })[] {
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY ordinal")
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      ordinal: r.ordinal as number,
      text: r.text as string,
      status: r.status as PlanStep["status"],
      attempts: r.attempts as number,
    }));
  }

  setStepStatus(runId: string, stepId: string, status: PlanStep["status"]): void {
    this.db.prepare("UPDATE steps SET status = ? WHERE run_id = ? AND id = ?").run(status, runId, stepId);
  }

  incStepAttempts(runId: string, stepId: string): number {
    this.db.prepare("UPDATE steps SET attempts = attempts + 1 WHERE run_id = ? AND id = ?").run(runId, stepId);
    const r = this.db.prepare("SELECT attempts FROM steps WHERE run_id = ? AND id = ?").get(runId, stepId) as
      | { attempts: number }
      | undefined;
    return r?.attempts ?? 0;
  }

  // ---- Transitions ----
  recordTransition(runId: string, from: StateName | null, to: StateName, operation: string, evidence?: string): void {
    this.db
      .prepare("INSERT INTO transitions (run_id, from_state, to_state, operation, evidence, created_at) VALUES (?,?,?,?,?,?)")
      .run(runId, from, to, operation, evidence ?? null, this.now());
  }

  getTransitions(runId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM transitions WHERE run_id = ? ORDER BY id").all(runId) as Record<
      string,
      unknown
    >[];
  }

  // ---- Sessions ----
  recordSession(
    runId: string,
    stepId: string,
    kind: string,
    sessionId: string,
    paneId: string | null,
    artifactPath: string,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO sessions (run_id, step_id, kind, session_id, pane_id, status, artifact_path, started_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(runId, stepId, kind, sessionId, paneId, "running", artifactPath, this.now());
    return Number(info.lastInsertRowid);
  }

  endSession(rowId: number, status: string): void {
    this.db.prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?").run(status, this.now(), rowId);
  }

  getSessionCount(runId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM sessions WHERE run_id = ?").get(runId) as { c: number };
    return r.c;
  }

  findSessionBySessionId(sessionId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM sessions WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  getSessions(runId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM sessions WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[];
  }

  // ---- Checkpoints ----
  recordCheckpoint(runId: string, stepId: string, gitHead: string, fingerprint: string): void {
    this.db
      .prepare("INSERT INTO checkpoints (run_id, step_id, git_head, fingerprint, created_at) VALUES (?,?,?,?,?)")
      .run(runId, stepId, gitHead, fingerprint, this.now());
  }

  getCheckpoints(runId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[];
  }

  // ---- Reviews ----
  recordReview(
    runId: string,
    iteration: number,
    verdict: string,
    testGate: boolean,
    rawPath: string | null,
    candidateFingerprint: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO reviews (run_id, iteration, verdict, test_gate, raw_path, candidate_fingerprint, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(runId, iteration, verdict, testGate ? 1 : 0, rawPath, candidateFingerprint, this.now());
  }

  getReviews(runId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY iteration").all(runId) as Record<string, unknown>[];
  }

  // ---- Counters (retry budgets, no-progress history, session ceiling) ----
  getCounter(runId: string, key: string): string | null {
    const r = this.db.prepare("SELECT value FROM counters WHERE run_id = ? AND key = ?").get(runId, key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setCounter(runId: string, key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO counters (run_id, key, value) VALUES (?,?,?) ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value",
      )
      .run(runId, key, value);
  }

  getNumber(runId: string, key: string): number {
    const v = this.getCounter(runId, key);
    return v === null ? 0 : Number(v);
  }

  setNumber(runId: string, key: string, value: number): void {
    this.setCounter(runId, key, String(value));
  }

  // ---- Exclusive run lock ----
  acquireLock(runId: string): boolean {
    const existing = this.db.prepare("SELECT pid, host FROM locks WHERE run_id = ?").get(runId) as
      | { pid: number; host: string }
      | undefined;
    if (existing) {
      // If the lock belongs to a live local process, refuse.
      if (existing.host === hostname() && isPidAlive(existing.pid)) return false;
      // Stale lock: take it over.
      this.db.prepare("DELETE FROM locks WHERE run_id = ?").run(runId);
    }
    try {
      this.db
        .prepare("INSERT INTO locks (run_id, pid, host, acquired_at) VALUES (?,?,?,?)")
        .run(runId, process.pid, hostname(), this.now());
      return true;
    } catch {
      return false;
    }
  }

  releaseLock(runId: string): void {
    this.db
      .prepare("DELETE FROM locks WHERE run_id = ? AND pid = ? AND host = ?")
      .run(runId, process.pid, hostname());
  }

  close(): void {
    this.db.close();
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
