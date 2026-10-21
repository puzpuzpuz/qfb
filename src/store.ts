import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import type { Decision, PlanStep, RunConfig, StateName, GitSnapshot } from "./types.ts";

export interface SessionRow {
  rowId: number;
  runId: string;
  stepId: string;
  kind: string;
  sessionId: string;
  paneId: string | null;
  status: string | null;
  artifactPath: string;
  startedAt: string;
  endedAt: string | null;
  /** OS pid of the session process (also its process-group id). */
  pid: number | null;
  host: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Set once the controller has durably acted on this session's outcome. */
  consumedAt: string | null;
  /** Git snapshot taken immediately before the session launched. */
  gitBefore: GitSnapshot | null;
}

export interface RunRow {
  id: string;
  repoPath: string;
  branch: string;
  /** The feature base as a commit SHA, resolved once at init so the review range never drifts. */
  baseRef: string;
  /** The base as the operator wrote it (e.g. `origin/master`); null for older runs. */
  baseSpec: string | null;
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
 * atomic. Exclusive locks prevent two controller instances from executing
 * the same run, or two runs from writing the same checkout (Section 15 / 4.4).
 */
export class Store {
  private readonly db: DatabaseSync;
  private txDepth = 0;

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
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        step_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        design_revised INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locks (
        run_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        host TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
    // Columns added after the initial schema (idempotent for existing DBs).
    this.ensureColumn("sessions", "pid", "INTEGER");
    this.ensureColumn("sessions", "host", "TEXT");
    this.ensureColumn("sessions", "exit_code", "INTEGER");
    this.ensureColumn("sessions", "timed_out", "INTEGER NOT NULL DEFAULT 0");
    if (this.ensureColumn("sessions", "consumed_at", "TEXT")) {
      // Older versions acted on every ended session without recording it; never replay those.
      this.db.exec("UPDATE sessions SET consumed_at = ended_at WHERE ended_at IS NOT NULL");
    }
    this.ensureColumn("sessions", "git_before", "TEXT");
    this.ensureColumn("runs", "base_spec", "TEXT");
  }

  /** Add a column if missing; returns true when it was just added. */
  private ensureColumn(table: string, column: string, def: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    return true;
  }

  /**
   * Run `fn` atomically. Nested calls join the outer transaction. `fn` must be
   * synchronous: an await inside would interleave other statements.
   */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  now(): string {
    return new Date().toISOString();
  }

  // ---- Runs ----
  createRun(row: Omit<RunRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, repo_path, branch, base_ref, base_spec, design_path, design_hash,
           config_json, state, approved, deny_list_json, stop_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.repoPath, row.branch, row.baseRef, row.baseSpec, row.designPath, row.designHash,
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
      baseSpec: (r.base_spec as string | null) ?? null,
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
   * this to resume an interrupted run instead of creating a duplicate. `base`
   * matches either the resolved SHA or the ref as originally given, so
   * `--base origin/master` still finds its run after a fetch moves the ref.
   */
  findRun(repoPath: string, designPath: string, base: string): RunRow | null {
    const r = this.db
      .prepare(
        `SELECT id FROM runs WHERE repo_path = ? AND design_path = ? AND (base_ref = ? OR base_spec = ?)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(repoPath, designPath, base, base) as { id: string } | undefined;
    return r ? this.getRun(r.id) : null;
  }

  /**
   * Delete every row that belongs to `runId`, in every table, atomically, then
   * compact the database. Updates leave older versions of a row in free space,
   * so deleting is not enough: VACUUM rebuilds every page from the live rows,
   * and the checkpoint carries that into the database file, so nothing of the
   * run (deny-list terms, plan text, evidence) remains. `scrubbed` is false if
   * another process kept the compaction from completing; the rows are gone
   * either way (overwritten by secure_delete), and the next clean compacts again.
   */
  deleteRun(runId: string): { rows: number; scrubbed: boolean } {
    const prev = (this.db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete;
    this.db.exec("PRAGMA secure_delete = ON");
    let rows = 0;
    try {
      this.tx(() => {
        for (const t of RUN_TABLES) {
          rows += Number(this.db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(runId).changes);
        }
        rows += Number(this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId).changes);
      });
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${prev}`);
    }
    let scrubbed = false;
    try {
      this.db.exec("VACUUM");
      scrubbed = (this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy === 0;
    } catch {
      // Busy: another process is writing. Reported, not fatal.
    }
    return { rows, scrubbed };
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

  /** Compare-and-set: move `from` -> `to` only if the run is still in `from`. */
  casState(id: string, from: StateName, to: StateName): boolean {
    const info = this.db.prepare("UPDATE runs SET state = ? WHERE id = ? AND state = ?").run(to, id, from);
    return Number(info.changes) === 1;
  }

  setStopReason(id: string, reason: string | null): void {
    this.db.prepare("UPDATE runs SET stop_reason = ? WHERE id = ?").run(reason, id);
  }

  setDesignHash(id: string, hash: string): void {
    this.db.prepare("UPDATE runs SET design_hash = ? WHERE id = ?").run(hash, id);
  }

  setDesignPath(id: string, path: string): void {
    this.db.prepare("UPDATE runs SET design_path = ? WHERE id = ?").run(path, id);
  }

  // ---- Operator decisions ----
  addDecision(runId: string, d: Omit<Decision, "id" | "createdAt">): number {
    const info = this.db
      .prepare(
        "INSERT INTO decisions (run_id, stage, step_id, question, answer, design_revised, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(runId, d.stage, d.stepId, d.question, d.answer, d.designRevised ? 1 : 0, this.now());
    return Number(info.lastInsertRowid);
  }

  getDecisions(runId: string): Decision[] {
    const rows = this.db.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      stage: r.stage as string,
      stepId: r.step_id as string,
      question: r.question as string,
      answer: r.answer as string,
      designRevised: (r.design_revised as number) === 1,
      createdAt: r.created_at as string,
    }));
  }

  // ---- Steps ----
  /** Replace the run's plan (a re-approved design), keeping status/attempts as given. */
  replaceSteps(runId: string, steps: (PlanStep & { attempts: number })[]): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      const stmt = this.db.prepare(
        "INSERT INTO steps (run_id, id, ordinal, text, status, attempts) VALUES (?,?,?,?,?,?)",
      );
      for (const s of steps) stmt.run(runId, s.id, s.ordinal, s.text, s.status, s.attempts);
    });
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
    gitBefore: GitSnapshot | null = null,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO sessions (run_id, step_id, kind, session_id, pane_id, status, artifact_path, started_at, git_before) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(runId, stepId, kind, sessionId, paneId, "running", artifactPath, this.now(), gitBefore ? JSON.stringify(gitBefore) : null);
    return Number(info.lastInsertRowid);
  }

  setSessionPid(rowId: number, pid: number, host: string): void {
    this.db.prepare("UPDATE sessions SET pid = ?, host = ? WHERE id = ?").run(pid, host, rowId);
  }

  endSession(rowId: number, status: string, exitCode: number | null = null, timedOut = false): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, ended_at = ?, exit_code = ?, timed_out = ? WHERE id = ?")
      .run(status, this.now(), exitCode, timedOut ? 1 : 0, rowId);
  }

  consumeSession(rowId: number): void {
    this.db.prepare("UPDATE sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(this.now(), rowId);
  }

  /** Mark every ended-but-unprocessed session consumed, so none is ever replayed. */
  consumeEndedSessions(runId: string): void {
    this.db
      .prepare("UPDATE sessions SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL AND ended_at IS NOT NULL")
      .run(this.now(), runId);
  }

  getSession(rowId: number): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(rowId) as Record<string, unknown> | undefined;
    return r ? toSessionRow(r) : null;
  }

  /** Most recent session of `kind` for `stepId` (the controller's resume key). */
  latestSession(runId: string, kind: string, stepId: string): SessionRow | null {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE run_id = ? AND kind = ? AND step_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId, kind, stepId) as Record<string, unknown> | undefined;
    return r ? toSessionRow(r) : null;
  }

  /** Sessions the controller launched but never observed ending. */
  openSessions(runId: string): SessionRow[] {
    return (
      this.db.prepare("SELECT * FROM sessions WHERE run_id = ? AND ended_at IS NULL ORDER BY id").all(runId) as Record<
        string,
        unknown
      >[]
    ).map(toSessionRow);
  }

  /** Count sessions, optionally filtered by kind/step and restricted to row ids > sinceRowId. */
  countSessions(runId: string, f: { kind?: string; stepId?: string; sinceRowId?: number } = {}): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) c FROM sessions WHERE run_id = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR step_id = ?) AND id > ?",
      )
      .get(runId, f.kind ?? null, f.kind ?? null, f.stepId ?? null, f.stepId ?? null, f.sinceRowId ?? 0) as { c: number };
    return r.c;
  }

  maxSessionRowId(runId: string): number {
    const r = this.db.prepare("SELECT MAX(id) m FROM sessions WHERE run_id = ?").get(runId) as { m: number | null };
    return r.m ?? 0;
  }

  getSessionCount(runId: string): number {
    return this.countSessions(runId);
  }

  getSessions(runId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM sessions WHERE run_id = ? ORDER BY id").all(runId) as Record<string, unknown>[];
  }

  getLatestSession(runId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM sessions WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(runId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
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

  deleteCounter(runId: string, key: string): void {
    this.db.prepare("DELETE FROM counters WHERE run_id = ? AND key = ?").run(runId, key);
  }

  getNumber(runId: string, key: string): number {
    const v = this.getCounter(runId, key);
    return v === null ? 0 : Number(v);
  }

  setNumber(runId: string, key: string, value: number): void {
    this.setCounter(runId, key, String(value));
  }

  // ---- Exclusive locks ----
  /**
   * Atomically acquire every key (all-or-nothing). Keys are run ids and
   * `repo:<path>` checkout keys, so neither the same run nor two runs on the
   * same checkout can be driven concurrently. BEGIN IMMEDIATE serializes the
   * check-then-insert across processes.
   */
  acquireLock(keys: string | string[]): boolean {
    const list = Array.isArray(keys) ? keys : [keys];
    return this.tx(() => {
      for (const k of list) {
        const h = this.lockHolder(k);
        // A live local holder (including this very process) refuses.
        if (h && h.host === hostname() && isPidAlive(h.pid)) return false;
      }
      const now = this.now();
      for (const k of list) {
        this.db.prepare("DELETE FROM locks WHERE run_id = ?").run(k);
        this.db
          .prepare("INSERT INTO locks (run_id, pid, host, acquired_at) VALUES (?,?,?,?)")
          .run(k, process.pid, hostname(), now);
      }
      return true;
    });
  }

  lockHolder(key: string): { pid: number; host: string; acquiredAt: string } | null {
    const r = this.db.prepare("SELECT pid, host, acquired_at FROM locks WHERE run_id = ?").get(key) as
      | { pid: number; host: string; acquired_at: string }
      | undefined;
    return r ? { pid: r.pid, host: r.host, acquiredAt: r.acquired_at } : null;
  }

  releaseLock(keys: string | string[]): void {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.db.prepare("DELETE FROM locks WHERE run_id = ? AND pid = ? AND host = ?").run(k, process.pid, hostname());
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Every table keyed by `run_id` (`runs` itself is keyed by `id`). Locks hold the run's lock row. */
const RUN_TABLES = ["steps", "transitions", "sessions", "checkpoints", "reviews", "counters", "decisions", "locks"] as const;

function toSessionRow(r: Record<string, unknown>): SessionRow {
  return {
    rowId: r.id as number,
    runId: r.run_id as string,
    stepId: r.step_id as string,
    kind: r.kind as string,
    sessionId: r.session_id as string,
    paneId: (r.pane_id as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    artifactPath: r.artifact_path as string,
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
    pid: (r.pid as number | null) ?? null,
    host: (r.host as string | null) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    timedOut: (r.timed_out as number | null) === 1,
    consumedAt: (r.consumed_at as string | null) ?? null,
    gitBefore: r.git_before ? (JSON.parse(r.git_before as string) as GitSnapshot) : null,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
