import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync, rmSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Store } from "./store.ts";
import type { RunRow, SessionRow } from "./store.ts";
import type { PaneLabel } from "./adapters/herdr.ts";
import type { PiLaunchResult, SessionRef } from "./adapters/pi.ts";
import { assertTransition, isActive, isOrthogonal, resumeTarget } from "./stateMachine.ts";
import { extractPlan, renderManifest } from "./plan.ts";
import { checkArtifact, confidentialityFailures, mechanicalGate } from "./gating.ts";
import type { ExpectedArtifact } from "./gating.ts";
import { parseReviewReport, selectActionableFindings, isAcceptable, AmbiguousReportError } from "./report.ts";
import { findingIdentity, bugIdentity, detectNoProgress } from "./identity.ts";
import { foldForMatch, scanForDenyTerms } from "./confidentiality.ts";
import { Git, GitError } from "./git.ts";
import { shellTestRunner } from "./procs.ts";
import type { TestRunner } from "./procs.ts";
import { State, AgentStatus, FixOutcome, DEFAULT_CONFIG, validateConfig } from "./types.ts";
import type { PiAdapter } from "./adapters/pi.ts";
import type { HerdrAdapter } from "./adapters/herdr.ts";
import type {
  AddedContent,
  GitSnapshot,
  PlanStep,
  ReviewReport,
  RunConfig,
  StateName,
  TaskArtifact,
  UnscannableFile,
  VerifiedTest,
} from "./types.ts";

/**
 * Minimal Git surface the controller depends on (injectable for tests). Every
 * method that feeds a gate throws GitError on failure; the controller pauses
 * instead of substituting a fallback.
 */
export interface GitLike {
  branch(): string;
  head(): string;
  /** The commit SHA `ref` names; throws when it does not resolve to a commit. */
  resolveCommit(ref: string): string;
  snapshot(base: string): GitSnapshot;
  /** Git-derived list of paths changed vs base (tracked incl. deletions, plus untracked). */
  changedFiles(base: string): string[];
  /** Git-derived content the change adds vs base, for the confidentiality scan. */
  addedContent(base: string): AddedContent;
  /** Human-readable diff vs base plus untracked contents (evidence only, never gated on). */
  workingDiff(base: string): string;
  isClean(): boolean;
  /** Commit the (already gated) working tree; returns the new HEAD. */
  commitAll(message: string): string;
}

export interface ControllerDeps {
  store: Store;
  pi: PiAdapter;
  herdr: HerdrAdapter;
  /** Factory so each run targets its own checkout; defaults to real Git. */
  makeGit?: (repoPath: string) => GitLike;
  /** Root directory for durable artifacts (outside the QuestDB tree). */
  artifactRoot: string;
  /** Re-runs claimed validation commands; defaults to `sh -c` in a process group. */
  runTest?: TestRunner;
  /**
   * How long a restarted controller waits for a previous controller's session
   * to finish dying (e.g. right after Ctrl-C) before declaring reconciliation.
   */
  orphanGraceMs?: number;
}

export interface InitOptions {
  repoPath: string;
  designPath: string;
  /** Feature base as a ref or SHA; resolved to a commit SHA at init. */
  base: string;
  config?: Partial<RunConfig>;
  denyList?: string[];
}

/** The candidate a successful review accepted; `build` pushes only this. */
export interface AcceptedCandidate {
  branch: string;
  head: string;
  fingerprint: string;
}

/** The plan as currently prepared for approval. */
export interface PlanInfo {
  /** True when this call re-extracted the plan and the steps changed. */
  changed: boolean;
  /** Step diff against the previous plan (`+` new, `-` removed, blank kept); empty when unchanged. */
  diff: string[];
  steps: number;
  ambiguous: boolean;
  notes: string[];
  strategy: string;
  preparedPlanPath: string;
}

/**
 * `approve` found that the design changed since the manifest was prepared and
 * re-extracted different steps. The new plan is stored; approving it needs a
 * second, deliberate `approve` after the operator has seen the diff.
 */
export class PlanChangedError extends Error {
  readonly diff: string[];
  constructor(runId: string, diff: string[]) {
    super(
      `The design changed since the plan was prepared, and its steps changed. Review the updated manifest ` +
        `('qfb plan ${runId}'), then run 'qfb approve ${runId}' again to approve it.`,
    );
    this.diff = diff;
  }
}

export class PauseSignal extends Error {}
/** Unwinds the run loop after the controller already persisted a stop/reconciliation. */
class HaltSignal extends Error {}

const STOP_STATES: StateName[] = [State.COMPLETED, State.FAILED, State.PAUSED, State.BLOCKED, State.RECONCILIATION];
export const DESIGN_CHANGED = "Approved design changed after approval; re-approval required.";

/** A run id `clean` will act on: one path segment, so it can never escape the artifact root. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Counter keys.
const PAUSE_REQUEST = "request-pause";
const STOP_REQUEST = "request-stop";
/** Highest session row id at the last operator retry of a FAILED run; budgets count sessions after it. */
const BUDGET_EPOCH = "budget-epoch";
const ACCEPTED = "accepted-candidate";
/** Hash of the design text the stored steps were extracted from. */
const PLAN_SOURCE_HASH = "plan-source-hash";
/** JSON notes explaining why the stored plan is ambiguous; absent when it is not. */
const PLAN_AMBIGUOUS = "plan-ambiguous";
/** Files the last gate could not scan, awaiting an operator's decision. */
const UNSCANNABLE_PENDING = "unscannable-pending";
/** Files (path + content digest) an operator vetted by hand; the scan skips exactly these. */
const UNSCANNABLE_ACCEPTED = "unscannable-accepted";

/** The artifact `kind` each session kind must write. */
const ARTIFACT_KIND: Record<string, TaskArtifact["kind"]> = {
  implementation: "implementation",
  "hardening-identify": "coverage-gap",
  "hardening-write": "bug",
  "hardening-fix": "bug",
  review: "review",
  fix: "fix",
};

const NO_CONTENT: AddedContent = { files: [], unscannable: [] };

interface Obtained {
  result: PiLaunchResult;
  row: SessionRow;
  before: GitSnapshot;
  /** Why the artifact was rejected (shape or identity), when it was. */
  problem: string | null;
}

export class Controller {
  private readonly store: Store;
  private readonly pi: PiAdapter;
  private readonly herdr: HerdrAdapter;
  private readonly makeGit: (repoPath: string) => GitLike;
  private readonly artifactRoot: string;
  private readonly runTest: TestRunner;
  private readonly orphanGraceMs: number;
  /**
   * Session whose outcome is being processed. The next state transition
   * consumes it in the same transaction, so an outcome is acted on exactly
   * once: a crash before that transition re-processes it; after, never again.
   */
  private inflight: number | null = null;

  constructor(deps: ControllerDeps) {
    this.store = deps.store;
    this.pi = deps.pi;
    this.herdr = deps.herdr;
    this.makeGit = deps.makeGit ?? ((p) => new Git(p));
    this.artifactRoot = deps.artifactRoot;
    this.runTest = deps.runTest ?? shellTestRunner;
    this.orphanGraceMs = deps.orphanGraceMs ?? 10_000;
  }

  // ---------------------------------------------------------------- init
  /**
   * Create a run and run the PREPARATION phase: read the design/handoff doc,
   * normalize it into QFB's canonical plan manifest (preserving wording and
   * order), write that manifest to QFB's own artifact store (never the
   * checkout), and extract the ordered steps. The developer approves the
   * normalized manifest before it is frozen.
   */
  init(opts: InitOptions): {
    runId: string;
    ambiguous: boolean;
    notes: string[];
    steps: number;
    strategy: string;
    preparedPlanPath: string;
  } {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const design = readFileSync(opts.designPath, "utf8");
    const designHash = sha256(design);

    const config = { ...DEFAULT_CONFIG, ...opts.config };
    validateConfig(config);
    const denyList = opts.denyList ?? [];
    const notes: string[] = [];
    for (const term of denyList) {
      const folded = foldForMatch(term);
      if (!folded) throw new Error(`Deny-list term ${JSON.stringify(term)} has no letters or digits, so it cannot be matched.`);
      if (folded.length < 3) {
        notes.push(`Deny-list term ${JSON.stringify(term)} is very short; substring matching will flag unrelated identifiers too.`);
      }
    }

    const git = this.makeGit(opts.repoPath);
    // Anchor the review range: a ref such as origin/master moves on the next fetch.
    let baseSha: string;
    try {
      baseSha = git.resolveCommit(opts.base);
    } catch (e) {
      throw new Error(`Base ${JSON.stringify(opts.base)} does not resolve to a commit in ${opts.repoPath}: ${(e as Error).message}`);
    }
    if (config.checkpointPolicy === "commit" && !git.isClean()) {
      // Commit checkpoints stage the whole gated tree; inherited changes would be swept in.
      throw new Error(
        "The commit checkpoint policy requires a clean checkout (QFB commits each verified change set). " +
          "Commit or stash your local changes first, or use snapshot checkpoints (omit --commit; for 'build', pass --no-pr).",
      );
    }

    this.store.createRun({
      id: runId,
      repoPath: opts.repoPath,
      branch: git.branch(),
      baseRef: baseSha,
      baseSpec: opts.base,
      designPath: opts.designPath,
      designHash,
      config,
      state: State.CREATED,
      approved: false,
      denyList,
      stopReason: null,
    });
    this.store.recordTransition(runId, null, State.CREATED, "init");

    // --- Preparation phase ---
    this.transition(runId, State.CREATED, State.PREPARING, "prepare");
    const plan = this.replan(this.requireRun(runId), design, designHash);
    this.transition(runId, State.PREPARING, State.AWAITING_APPROVAL, "prepared",
      JSON.stringify({ strategy: plan.strategy, steps: plan.steps, ambiguous: plan.ambiguous }));

    return {
      runId,
      ambiguous: plan.ambiguous,
      notes: [...plan.notes, ...notes],
      steps: plan.steps,
      strategy: plan.strategy,
      preparedPlanPath: plan.preparedPlanPath,
    };
  }

  /**
   * Bring the prepared plan up to date with the design on disk before approval:
   * when the design changed since the steps were extracted, re-extract them
   * (see replan). Only valid while the run awaits (re-)approval.
   */
  refreshPlan(runId: string): PlanInfo {
    return this.withRunLock(runId, () => {
      const run = this.requireRun(runId);
      this.assertApprovable(run);
      const design = readFileSync(run.designPath, "utf8");
      const hash = sha256(design);
      if (hash !== this.store.getCounter(runId, PLAN_SOURCE_HASH)) return this.replan(run, design, hash);
      return this.planInfo(runId);
    });
  }

  /**
   * Approve (or re-approve after a design change) and freeze the design hash.
   * The approved hash and the steps always describe the same design text: if
   * the design changed since the steps were extracted, they are re-extracted
   * first, and a changed plan must be reviewed and approved in a second call.
   * A plan with no steps is never approved.
   */
  approve(runId: string): void {
    this.withRunLock(runId, () => {
      const run = this.requireRun(runId);
      this.assertApprovable(run);
      const design = readFileSync(run.designPath, "utf8");
      const hash = sha256(design);
      const noSteps = () =>
        new Error(
          `Run ${runId} has no plan steps: none could be extracted from ${run.designPath}. ` +
            `Give it an ordered Implementation Plan, then approve again.`,
        );
      if (hash !== this.store.getCounter(runId, PLAN_SOURCE_HASH)) {
        const plan = this.replan(run, design, hash);
        if (plan.steps === 0) throw noSteps();
        if (plan.changed) throw new PlanChangedError(runId, plan.diff);
      }
      if (this.store.getSteps(runId).length === 0) throw noSteps();
      this.store.tx(() => {
        this.store.setDesignHash(runId, hash);
        this.store.setApproved(runId);
        this.store.setStopReason(runId, null);
        this.reopenSteps(runId);
        // A held session outcome belongs to the previous plan: never re-process it.
        this.store.consumeEndedSessions(runId);
        // Re-approval returns to the interrupted phase, not to the start, unless
        // the new plan has unimplemented steps: those come first.
        let to: StateName = run.state === State.PAUSED ? this.resumeStateOf(runId) : State.READY;
        const unfinished = this.store.getSteps(runId).some((s) => s.status !== "done");
        if (unfinished && to !== State.READY) to = State.IMPLEMENTING;
        this.transition(runId, run.state, to, "approve");
      });
    });
  }

  /** approve/refreshPlan apply only to a run awaiting approval or paused by a design change. */
  private assertApprovable(run: RunRow): void {
    if (run.state === State.AWAITING_APPROVAL) return;
    if (run.state === State.PAUSED && run.stopReason === DESIGN_CHANGED) return;
    const hint =
      isOrthogonal(run.state) && this.designChanged(run.id)
        ? ` Its design changed: 'qfb resume ${run.id}' reconciles that and asks for re-approval.`
        : isOrthogonal(run.state)
          ? ` To continue it, use 'qfb resume ${run.id}'.`
          : "";
    throw new Error(`Run ${run.id} is not awaiting approval (state=${run.state}).${hint}`);
  }

  /**
   * Extract the plan from `design` and store it with its source hash. Steps
   * whose text is unchanged keep their id, status and attempts; new or edited
   * steps get fresh ids (never reused, so no earlier session or budget is
   * attributed to them) and start pending; removed steps are dropped. A design
   * that yields no steps is not stored, so earlier progress is never lost.
   */
  private replan(run: RunRow, design: string, hash: string): PlanInfo {
    const ex = extractPlan(design);
    const runId = run.id;
    const preparedPlanPath = this.artifactPath(runId, "prepared-plan.md");
    const header =
      `<!-- QFB prepared plan for ${runId} -->\n` +
      `<!-- source design/handoff: ${run.designPath} (sha256 ${hash}) -->\n` +
      `<!-- approve with: qfb approve ${runId} -->\n\n`;
    const old = this.store.getSteps(runId);
    if (ex.steps.length === 0) {
      if (old.length === 0) {
        // Nothing to lose: show the operator why nothing was extracted.
        writeFileSync(preparedPlanPath, header + renderManifest([], ex.notes));
        this.store.setCounter(runId, "prepared-plan-path", preparedPlanPath);
        this.store.setCounter(runId, "plan-strategy", ex.strategy);
      }
      return { changed: false, diff: [], steps: 0, ambiguous: true, notes: ex.notes, strategy: ex.strategy, preparedPlanPath };
    }

    const fresh = this.store.getSessionCount(runId) === 0;
    let nextId = old.reduce((m, s) => Math.max(m, Number(s.id.replace(/^S/, "")) || 0), 0) + 1;
    const used = new Set<string>();
    const diff: string[] = [];
    const merged: (PlanStep & { attempts: number })[] = ex.steps.map((s, i) => {
      const keep = old.find((o) => !used.has(o.id) && o.text === s.text);
      if (keep) used.add(keep.id);
      const id = fresh ? `S${i + 1}` : keep?.id ?? `S${nextId++}`;
      diff.push(`${keep ? " " : "+"} ${id}  ${firstLine(s.text)}`);
      return keep && !fresh
        ? { ...keep, ordinal: i + 1 }
        : { id, ordinal: i + 1, text: s.text, status: "pending", attempts: 0 };
    });
    for (const o of old) if (!used.has(o.id)) diff.push(`- ${o.id}  ${firstLine(o.text)}`);
    const changed = JSON.stringify(old.map((s) => [s.id, s.text])) !== JSON.stringify(merged.map((s) => [s.id, s.text]));

    this.store.tx(() => {
      if (changed) this.store.replaceSteps(runId, merged);
      this.store.setCounter(runId, "prepared-plan-path", preparedPlanPath);
      this.store.setCounter(runId, "plan-strategy", ex.strategy);
      this.store.setCounter(runId, PLAN_SOURCE_HASH, hash);
      if (ex.ambiguous) this.store.setCounter(runId, PLAN_AMBIGUOUS, JSON.stringify(ex.notes));
      else this.store.deleteCounter(runId, PLAN_AMBIGUOUS);
      writeFileSync(preparedPlanPath, header + renderManifest(merged, ex.notes));
    });
    return {
      changed,
      diff: changed ? diff : [],
      steps: merged.length,
      ambiguous: ex.ambiguous,
      notes: ex.notes,
      strategy: ex.strategy,
      preparedPlanPath,
    };
  }

  private planInfo(runId: string): PlanInfo {
    const ambiguous = this.store.getCounter(runId, PLAN_AMBIGUOUS);
    return {
      changed: false,
      diff: [],
      steps: this.store.getSteps(runId).length,
      ambiguous: ambiguous !== null,
      notes: ambiguous ? (JSON.parse(ambiguous) as string[]) : [],
      strategy: this.store.getCounter(runId, "plan-strategy") ?? "none",
      preparedPlanPath: this.store.getCounter(runId, "prepared-plan-path") ?? this.artifactPath(runId, "prepared-plan.md"),
    };
  }

  // ---------------------------------------------------------------- run loop
  /**
   * Execute the workflow to the next natural stopping point. Acquires the
   * exclusive run + checkout lock, reconciles any session a previous
   * controller left behind, then drives deterministic `advance()` calls until
   * the run reaches a terminal, paused, blocked, failed, or reconciliation state.
   */
  async run(runId: string): Promise<StateName> {
    const run0 = this.requireRun(runId);
    const keys = [runId, repoLockKey(run0.repoPath)];
    if (!this.store.acquireLock(keys)) {
      throw new Error(
        this.store.lockHolder(runId)
          ? this.lockedMessage(runId)
          : `Checkout ${run0.repoPath} is in use by another QFB run; only one writer may drive a checkout at a time.`,
      );
    }
    try {
      if (!run0.approved || [State.CREATED, State.PREPARING, State.AWAITING_APPROVAL].includes(run0.state as never)) {
        throw new Error(`Run ${runId} is not approved (state=${run0.state}); run 'qfb approve ${runId}' first.`);
      }
      // Design-integrity reconciliation (Section 5 / Section 14).
      if (this.designChanged(runId)) throw new PauseSignal(DESIGN_CHANGED);
      // Crash recovery (Section 9): never start a writer next to a live one.
      await this.reconcileInflight(runId);

      let guard = 0;
      while (guard++ < 10_000) {
        const run = this.requireRun(runId);
        if (STOP_STATES.includes(run.state)) return run.state;
        if (this.store.getCounter(runId, STOP_REQUEST) !== null) this.haltForStop(runId, null);
        if (this.store.getCounter(runId, PAUSE_REQUEST) !== null) {
          // Graceful: honored between sessions, never interrupting an active write.
          this.stopRun(runId, State.PAUSED, "Operator requested pause.");
          continue;
        }
        if (this.sessionsSinceEpoch(runId) >= run.config.maxTotalSessions) {
          this.stopRun(runId, State.FAILED, "Hard ceiling on total Pi sessions reached.");
          continue;
        }
        await this.advance(runId);
      }
      throw new Error("Run loop exceeded guard limit.");
    } catch (e) {
      if (e instanceof PauseSignal) {
        this.stopRun(runId, State.PAUSED, e.message);
        return State.PAUSED;
      }
      if (e instanceof HaltSignal) return this.requireRun(runId).state;
      if (e instanceof GitError) {
        // Fail closed: a gate is never evaluated on substitute evidence. The
        // session's outcome (if any) is kept and re-gated after the fix.
        this.holdOutcome(runId);
        this.stopRun(runId, State.PAUSED,
          `Git failed, so the checkout could not be verified: ${e.message}. Fix the cause, then 'qfb resume ${runId}'.`);
        return State.PAUSED;
      }
      throw e;
    } finally {
      this.inflight = null;
      this.store.releaseLock(keys);
    }
  }

  /** One deterministic controller decision based solely on persisted state. */
  private async advance(runId: string): Promise<void> {
    if (this.inflight !== null) {
      throw new Error(`internal: outcome of session row ${this.inflight} was never recorded`);
    }
    const run = this.requireRun(runId);
    switch (run.state) {
      case State.READY:
        this.transition(runId, State.READY, State.IMPLEMENTING, "begin-implementation");
        return;
      case State.IMPLEMENTING:
        await this.doImplementationStep(runId);
        return;
      case State.HARDENING_IDENTIFY:
      case State.HARDENING_WRITE_TESTS:
      case State.HARDENING_FIX_BUGS:
        await this.doHardening(runId);
        return;
      case State.REVIEWING:
        await this.doReview(runId);
        return;
      case State.FIXING:
        await this.doFix(runId);
        return;
      case State.VERIFYING_STEP:
      case State.CHECKPOINTING:
        // Outcomes are now recorded atomically through these states; they are
        // only found persisted in stores written by older versions. Re-enter
        // the step: its unconsumed session outcome is re-processed, not relaunched.
        this.transition(runId, run.state, State.IMPLEMENTING, "crash-recovery");
        return;
      case State.VERIFYING_FIX:
        // Likewise legacy-only: re-review the current candidate.
        this.transition(runId, State.VERIFYING_FIX, State.REVIEWING, "crash-recovery");
        return;
      default:
        throw new Error(`advance() called in non-actionable state ${run.state}`);
    }
  }

  // ---------------------------------------------------- Phase B: implementation
  private async doImplementationStep(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const steps = this.store.getSteps(runId);
    const next = steps.find((s) => s.status === "pending" || s.status === "active");
    if (!next) {
      // All steps done → Phase C (hardening) before stabilization.
      this.transition(runId, State.IMPLEMENTING, State.HARDENING_IDENTIFY, "all-steps-done");
      return;
    }
    const git = this.makeGit(run.repoPath);

    let got = this.unconsumed(runId, "implementation", next.id);
    if (!got) {
      const attempts = this.store.tx(() => {
        this.store.setStepStatus(runId, next.id, "active");
        return this.store.incStepAttempts(runId, next.id);
      });
      const completed = steps.filter((s) => s.status === "done").map((s) => s.id);
      const artifactPath = this.artifactPath(runId, `${next.id}-attempt${attempts}.json`);
      got = await this.launchSession(run, git, {
        kind: "implementation",
        stepId: next.id,
        sessionId: `${runId}-${next.id}-a${attempts}`,
        artifactPath,
        label: { feature: runId, phase: "IMPLEMENTING", stepId: next.id },
        prompt: this.buildStepPrompt(run, next, completed, artifactPath, attempts),
      });
    }

    const { result, before, row } = got;
    const a = result.artifact;
    const claimed = a?.status;

    // Claimed BLOCKED / NEEDS_DECISION route to orthogonal states (Section 6 table).
    if (claimed === AgentStatus.NEEDS_DECISION) {
      this.stopRun(runId, State.PAUSED, `Step ${next.id} needs a human decision: ${a?.summary ?? ""}`);
      return;
    }
    if (claimed === AgentStatus.BLOCKED) {
      this.store.tx(() => {
        this.store.setStepStatus(runId, next.id, "blocked");
        this.stopRun(runId, State.BLOCKED, `Step ${next.id} blocked: ${a?.summary ?? ""}`);
      });
      return;
    }

    const verified = claimed === AgentStatus.DONE && a ? await this.verifyTests(run, a, row) : [];
    const after = git.snapshot(run.baseRef);
    const gate = mechanicalGate({
      mode: "writer",
      artifact: a,
      artifactProblem: got.problem,
      sessionCompleted: result.settled && !result.timedOut,
      before,
      after,
      expectedBranch: run.branch,
      allowedPathPrefixes: [],
      denyList: run.denyList,
      ...this.writerEvidence(run, git),
      verifiedTests: verified,
    });
    const reasons = claimed && claimed !== AgentStatus.DONE ? [`agent claimed ${claimed}: ${a?.summary ?? ""}`, ...gate.failures] : gate.failures;
    const evidence = JSON.stringify({ claimed, gate: gate.passed, failures: reasons, tests: verified });

    this.noteUnscannable(runId, gate.unscannable);
    if (gate.vetOnly && claimed === AgentStatus.DONE) {
      this.holdForVetting(runId, gate.unscannable, `Step ${next.id}`);
      return;
    }
    if (gate.passed && claimed === AgentStatus.DONE) {
      // Side effect first; the DB records below are one atomic batch. A crash in
      // between replays this outcome, and commitAll() is then a no-op.
      const head = this.checkpointCommit(run, git, next.id, a!.summary);
      this.rememberTests(runId, verified);
      this.store.tx(() => {
        this.transition(runId, State.IMPLEMENTING, State.VERIFYING_STEP, "session-settled", evidence);
        this.transition(runId, State.VERIFYING_STEP, State.CHECKPOINTING, "gate-passed");
        this.store.recordCheckpoint(runId, next.id, head, after.dirtyFingerprint);
        this.store.setStepStatus(runId, next.id, "done");
        this.store.deleteCounter(runId, `gate-failures:${next.id}`);
        this.transition(runId, State.CHECKPOINTING, State.IMPLEMENTING, "checkpointed");
      });
      return;
    }

    this.store.tx(() => {
      this.transition(runId, State.IMPLEMENTING, State.VERIFYING_STEP, "session-settled", evidence);
      this.store.setCounter(runId, `gate-failures:${next.id}`, JSON.stringify(reasons));
      if (gate.pause) {
        this.stopRun(runId, State.PAUSED, `Step ${next.id} failed a scope/integrity gate: ${reasons.join("; ")}`);
        return;
      }
      const used = this.sessionsSinceEpoch(runId, { kind: "implementation", stepId: next.id });
      if (used >= run.config.maxImplAttemptsPerStep) {
        this.store.setStepStatus(runId, next.id, "failed");
        this.stopRun(runId, State.FAILED, `Step ${next.id} exhausted ${used} attempt(s): ${reasons.join("; ")}`);
        return;
      }
      // Remain the active step for a bounded correction attempt.
      this.transition(runId, State.VERIFYING_STEP, State.IMPLEMENTING, "gate-failed-retry", reasons.join("; "));
    });
  }

  // ------------------------------------------------- Phase C: hardening
  /**
   * identify (read-only) → write tests (writer) → fix bugs (writer, loops)
   * → [next pass] → review. Every stage is mechanically gated; open bugs never
   * reach Phase D: they are fixed, or the run stops with the evidence.
   */
  private async doHardening(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const stage = run.state;
    const key = stage === State.HARDENING_IDENTIFY ? "identify" : stage === State.HARDENING_WRITE_TESTS ? "write" : "fix";
    const kind = `hardening-${key}`;
    const pass = this.store.getNumber(runId, "hardening-pass");
    const stepId = `${key}-p${pass}`;
    const readOnly = key === "identify";
    const git = this.makeGit(run.repoPath);

    let got = this.unconsumed(runId, kind, stepId);
    if (!got) {
      const n = this.store.countSessions(runId, { kind, stepId }) + 1;
      const artifactPath = this.artifactPath(runId, `hardening-${key}-p${pass}-a${n}.json`);
      got = await this.launchSession(run, git, {
        kind,
        stepId,
        sessionId: `${runId}-harden-${key}-p${pass}-a${n}`,
        artifactPath,
        label: { feature: runId, phase: stage, stepId },
        prompt: this.buildHardeningPrompt(run, stage, stepId, artifactPath, `gate-failures:${kind}:${stepId}`),
      });
    }

    const { result, before, row } = got;
    const a = result.artifact;
    const claimed = a?.status;
    if (claimed === AgentStatus.NEEDS_DECISION) {
      this.stopRun(runId, State.PAUSED, `Hardening ${key} stage needs a human decision: ${a?.summary ?? ""}`);
      return;
    }
    if (claimed === AgentStatus.BLOCKED) {
      this.stopRun(runId, State.BLOCKED, `Hardening ${key} stage blocked: ${a?.summary ?? ""}`);
      return;
    }
    if (key === "fix" && a?.fixOutcome && a.fixOutcome !== FixOutcome.CLEAN) {
      this.stopRun(runId, State.FAILED,
        `Hardening bug fix returned ${a.fixOutcome}; stopping normal progression (evidence: ${row.artifactPath}).`);
      return;
    }

    const verified = !readOnly && claimed === AgentStatus.DONE && a ? await this.verifyTests(run, a, row) : [];
    const after = git.snapshot(run.baseRef);
    const gate = mechanicalGate({
      mode: readOnly ? "read-only" : "writer",
      artifact: a,
      artifactProblem: got.problem,
      sessionCompleted: result.settled && !result.timedOut,
      before,
      after,
      expectedBranch: run.branch,
      allowedPathPrefixes: [],
      denyList: run.denyList,
      ...(readOnly ? { changedFiles: [], added: NO_CONTENT } : this.writerEvidence(run, git)),
      verifiedTests: verified,
      allowFailingTestsWithBugs: true,
    });
    const reasons = claimed && claimed !== AgentStatus.DONE ? [`agent claimed ${claimed}: ${a?.summary ?? ""}`, ...gate.failures] : gate.failures;
    const evidence = JSON.stringify({ claimed, gate: gate.passed, failures: reasons, tests: verified });

    this.noteUnscannable(runId, gate.unscannable);
    if (gate.vetOnly && claimed === AgentStatus.DONE) {
      this.holdForVetting(runId, gate.unscannable, `Hardening ${key} stage`);
      return;
    }
    if (!gate.passed || claimed !== AgentStatus.DONE) {
      const budget = key === "fix" ? run.config.maxHardeningFixIterations : run.config.maxHardeningTestAttempts;
      this.store.tx(() => {
        if (gate.pause) {
          this.stopRun(runId, State.PAUSED, `Hardening ${key} stage failed a scope/integrity gate: ${reasons.join("; ")}`);
          return;
        }
        const used = this.sessionsSinceEpoch(runId, { kind, stepId });
        if (used >= budget) {
          this.stopRun(runId, State.FAILED,
            `Hardening ${key} stage (pass ${pass}) exhausted ${used} attempt(s): ${reasons.join("; ")}`);
          return;
        }
        this.store.setCounter(runId, `gate-failures:${kind}:${stepId}`, JSON.stringify(reasons));
        this.transition(runId, stage, stage, "hardening-retry", evidence);
      });
      return;
    }

    const bugs = a!.bugs ?? [];
    if (key === "identify") {
      this.store.tx(() => {
        this.store.setCounter(runId, "hardening-gap-artifact", row.artifactPath);
        this.transition(runId, stage, State.HARDENING_WRITE_TESTS, "gap-handoff-verified", evidence);
      });
      return;
    }

    const head = this.checkpointCommit(run, git, `hardening-${key}-p${pass}`, a!.summary);
    this.rememberTests(runId, verified);

    if (key === "write") {
      this.store.tx(() => {
        this.store.recordCheckpoint(runId, stepId, head, after.dirtyFingerprint);
        if (bugs.length === 0) {
          // The adversarial tests found nothing: Phase C is complete.
          this.transition(runId, stage, State.REVIEWING, "hardening-complete", evidence);
          return;
        }
        this.store.setCounter(runId, "open-bugs", JSON.stringify(bugs));
        this.store.setCounter(runId, "hardening-bug-artifact", row.artifactPath);
        this.transition(runId, stage, State.HARDENING_FIX_BUGS, "tests-written", evidence);
      });
      return;
    }

    // key === "fix": `bugs` are the ones STILL open after this session.
    const ids = bugs.map((b) => bugIdentity(b));
    const history = JSON.parse(this.store.getCounter(runId, "bug-identity-history") ?? "[]") as string[][];
    const survivors = detectNoProgress(history, ids, run.config.maxNoProgress);
    history.push(ids);
    this.store.tx(() => {
      this.store.recordCheckpoint(runId, stepId, head, after.dirtyFingerprint);
      this.store.setCounter(runId, "bug-identity-history", JSON.stringify(history));
      if (bugs.length === 0) {
        this.store.deleteCounter(runId, "open-bugs");
        if (pass + 1 < run.config.maxHardeningGapPasses) {
          // This pass exposed (and fixed) bugs: hunt again over the new code.
          this.store.setNumber(runId, "hardening-pass", pass + 1);
          this.transition(runId, stage, State.HARDENING_IDENTIFY, "hardening-next-pass", evidence);
        } else {
          this.transition(runId, stage, State.REVIEWING, "hardening-complete", evidence);
        }
        return;
      }
      this.store.setCounter(runId, "open-bugs", JSON.stringify(bugs));
      if (survivors.length > 0) {
        this.stopRun(runId, State.FAILED, `Hardening bug(s) recur with unchanged identity (no progress): ${survivors.join(", ")}`);
        return;
      }
      const used = this.sessionsSinceEpoch(runId, { kind, stepId });
      if (used >= run.config.maxHardeningFixIterations) {
        this.stopRun(runId, State.FAILED,
          `Hardening fix budget exhausted with ${bugs.length} bug(s) still failing: ${bugs.map((b) => b.id).join(", ")}`);
        return;
      }
      this.transition(runId, stage, stage, "hardening-fix-retry", `${bugs.length} bug(s) still open`);
    });
  }

  // ------------------------------------------------- Phase D: review/fix
  private async doReview(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const git = this.makeGit(run.repoPath);

    let got = this.unconsumed(runId, "review", "review");
    if (!got) {
      const used = this.sessionsSinceEpoch(runId, { kind: "review" });
      if (used >= run.config.maxReviewIterations) {
        // Do NOT auto-accept an incomplete review on hitting the cap (Section 8.2).
        this.stopRun(runId, State.FAILED, `Review iteration limit (${run.config.maxReviewIterations}) reached without acceptance.`);
        return;
      }
      const n = this.store.countSessions(runId, { kind: "review" }) + 1;
      const artifactPath = this.artifactPath(runId, `review-${n}.json`);
      got = await this.launchSession(run, git, {
        kind: "review",
        stepId: "review",
        sessionId: `${runId}-review-${n}`,
        artifactPath,
        label: { feature: runId, phase: "REVIEWING", stepId: "review", reviewIteration: n },
        prompt: this.buildReviewPrompt(run, artifactPath),
      });
    }

    const { result, before } = got;
    const a = result.artifact;
    const candidate = git.snapshot(run.baseRef);
    // Read-only gate: the review must not touch the checkout, so its verdict
    // is about exactly this candidate.
    const gate = mechanicalGate({
      mode: "read-only",
      artifact: a,
      artifactProblem: got.problem,
      sessionCompleted: result.settled && !result.timedOut,
      before,
      after: candidate,
      expectedBranch: run.branch,
      allowedPathPrefixes: [],
      denyList: run.denyList,
      changedFiles: [],
      added: NO_CONTENT,
      verifiedTests: [],
    });
    if (!gate.passed) {
      this.stopRun(runId, State.PAUSED, `Review session rejected by the read-only gate: ${gate.failures.join("; ")}`);
      return;
    }
    if (!a!.reviewReportPath || !existsSync(a!.reviewReportPath)) {
      this.stopRun(runId, State.PAUSED, "Review session did not preserve a raw review-pr report.");
      return;
    }
    const raw = await readFile(a!.reviewReportPath, "utf8");

    let report: ReviewReport;
    try {
      report = parseReviewReport(raw);
    } catch (e) {
      if (e instanceof AmbiguousReportError) {
        this.stopRun(runId, State.PAUSED, `Review report ambiguous — cannot extract verdict/findings: ${e.message}`);
        return;
      }
      throw e;
    }
    const iteration = this.store.getReviews(runId).length + 1;
    const record = () =>
      this.store.recordReview(runId, iteration, report.verdict, report.testGatePassed, a!.reviewReportPath!, candidate.dirtyFingerprint);

    if (report.verdict === "needs-discussion") {
      this.store.tx(() => {
        record();
        this.stopRun(runId, State.PAUSED, "Review returned needs-discussion; a human decision is required.");
      });
      return;
    }

    if (isAcceptable(report, run.config.strictReviewPolicy)) {
      // Final confidentiality gate over everything the candidate adds vs base.
      // Every writer stage was scanned, but a pause can be resumed without the
      // leak being removed (e.g. fix-pr's resumes straight into review).
      const { added } = this.writerEvidence(run, git);
      const leaks = confidentialityFailures(added, run.denyList);
      this.noteUnscannable(runId, leaks.length > 0 ? added.unscannable : []);
      if (leaks.length > 0 && leaks.length === added.unscannable.length) {
        this.holdForVetting(runId, added.unscannable, "Final confidentiality check of the reviewed candidate");
        return;
      }
      if (leaks.length > 0) {
        this.store.tx(() => {
          record();
          this.stopRun(runId, State.PAUSED,
            `Final confidentiality check of the reviewed candidate failed: ${leaks.join(" ")} ` +
              `Remove the leak, then 'qfb resume ${runId}' (a fresh review follows).`);
        });
        return;
      }

      // Final mechanical test gate on the reviewed candidate: every validation
      // command accepted during the run is re-run here by the controller.
      const suite = await this.runRegressionSuite(run, got.row);
      const final = git.snapshot(run.baseRef);
      const failing = suite.filter((t) => t.exitCode !== 0);
      this.store.tx(() => {
        record();
        if (final.dirtyFingerprint !== candidate.dirtyFingerprint || final.head !== candidate.head) {
          this.stopRun(runId, State.PAUSED, "Checkout changed during final verification; the review result is stale and cannot be accepted.");
          return;
        }
        if (failing.length > 0) {
          this.stopRun(runId, State.PAUSED,
            `Final regression run failed on the reviewed candidate: ${failing.map((t) => `"${t.command}" exit ${t.exitCode} (log: ${t.logPath})`).join("; ")}. ` +
              `Fix the cause (or, if a command is obsolete, remove it from ${this.suitePath(runId)}), then 'qfb resume ${runId}'.`);
          return;
        }
        const accepted: AcceptedCandidate = { branch: candidate.branch, head: candidate.head, fingerprint: candidate.dirtyFingerprint };
        this.store.setCounter(runId, ACCEPTED, JSON.stringify(accepted));
        this.store.setStopReason(runId, null);
        this.transition(runId, State.REVIEWING, State.COMPLETED, "review-accepted",
          JSON.stringify({ accepted, regression: suite.length }));
      });
      return;
    }

    // Not acceptable, but nothing is mechanically fixable: the test gate failed
    // or the only findings are non-actionable (e.g. adjacent). Entering fix-pr
    // with an empty authorized set would spin pointlessly — require a human.
    const actionable = selectActionableFindings(report, run.config.strictReviewPolicy);
    if (actionable.length === 0) {
      const why = !report.testGatePassed
        ? "the review test gate failed"
        : "the review is not acceptable but produced no actionable findings";
      this.store.tx(() => {
        record();
        this.stopRun(runId, State.PAUSED, `Cannot auto-remediate: ${why}; a human decision is required.`);
      });
      return;
    }

    // No-progress detection over finding identity (Section 8.2).
    const ids = actionable.map(findingIdentity);
    const history = JSON.parse(this.store.getCounter(runId, "finding-identity-history") ?? "[]") as string[][];
    const survivors = detectNoProgress(history, ids, run.config.maxNoProgress);
    history.push(ids);
    this.store.tx(() => {
      record();
      this.store.setCounter(runId, "finding-identity-history", JSON.stringify(history));
      if (survivors.length > 0) {
        this.stopRun(runId, State.FAILED, `Blocker(s) survive remediation without progress: ${survivors.join(", ")}`);
        return;
      }
      // Stash selected findings for the fix session, then transition.
      this.store.setCounter(runId, "pending-findings", JSON.stringify(actionable));
      this.transition(runId, State.REVIEWING, State.FIXING, "blocking-findings");
    });
  }

  private async doFix(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const git = this.makeGit(run.repoPath);
    const findings = JSON.parse(this.store.getCounter(runId, "pending-findings") ?? "[]");

    let got = this.unconsumed(runId, "fix", "fix");
    if (!got) {
      const n = this.store.countSessions(runId, { kind: "fix" }) + 1;
      const artifactPath = this.artifactPath(runId, `fix-${n}.json`);
      got = await this.launchSession(run, git, {
        kind: "fix",
        stepId: "fix",
        sessionId: `${runId}-fix-${n}`,
        artifactPath,
        label: { feature: runId, phase: "FIXING", stepId: "fix", reviewIteration: n },
        prompt: this.buildFixPrompt(run, findings, artifactPath),
      });
    }

    const { result, before, row } = got;
    const a = result.artifact;
    if (a?.status === AgentStatus.NEEDS_DECISION) {
      this.stopRun(runId, State.PAUSED, `fix-pr needs a human decision: ${a.summary}`);
      return;
    }
    const outcome = a?.fixOutcome;
    if (outcome !== FixOutcome.CLEAN) {
      // Only Clean may advance the normal workflow (Section 3).
      const what = a ? `returned ${outcome ?? "no fixOutcome"}` : `left no valid artifact (${got.problem ?? "unknown"})`;
      this.stopRun(runId, State.FAILED, `fix-pr ${what}; stopping normal progression.`);
      return;
    }

    // A Clean claim is still only a claim: gate it like any other writer.
    const verified = a!.status === AgentStatus.DONE ? await this.verifyTests(run, a!, row) : [];
    const after = git.snapshot(run.baseRef);
    const gate = mechanicalGate({
      mode: "writer",
      artifact: a,
      sessionCompleted: result.settled && !result.timedOut,
      before,
      after,
      expectedBranch: run.branch,
      allowedPathPrefixes: [],
      denyList: run.denyList,
      ...this.writerEvidence(run, git),
      verifiedTests: verified,
    });
    const reasons = a!.status !== AgentStatus.DONE ? [`agent claimed ${a!.status}: ${a!.summary}`, ...gate.failures] : gate.failures;
    const evidence = JSON.stringify({ outcome, gate: gate.passed, failures: reasons, tests: verified });
    // No hold here: resuming a fix pause goes to a fresh review, whose final
    // confidentiality check re-examines these files (vetted or not).
    this.noteUnscannable(runId, gate.unscannable);

    if (!gate.passed || a!.status !== AgentStatus.DONE) {
      this.store.tx(() => {
        this.transition(runId, State.FIXING, State.VERIFYING_FIX, "fix-claimed-clean", evidence);
        this.stopRun(runId, gate.pause ? State.PAUSED : State.FAILED,
          `fix-pr claimed Clean but mechanical verification failed: ${reasons.join("; ")}` +
            (gate.vetOnly ? ` If the file(s) are clean, 'qfb resume ${runId} --accept-unscannable'.` : ""));
      });
      return;
    }

    const n = this.store.countSessions(runId, { kind: "fix" });
    const head = this.checkpointCommit(run, git, `fix-${n}`, a!.summary);
    this.rememberTests(runId, verified);
    this.store.tx(() => {
      this.transition(runId, State.FIXING, State.VERIFYING_FIX, "fix-clean", evidence);
      this.store.recordCheckpoint(runId, `fix-${n}`, head, after.dirtyFingerprint);
      this.transition(runId, State.VERIFYING_FIX, State.REVIEWING, "fix-verified");
    });
  }

  // ---------------------------------------------------------------- control ops
  /**
   * Request a safe pause. With no live controller the run pauses at once;
   * otherwise the live controller pauses after its current session finishes
   * (never interrupting an active write).
   */
  pause(runId: string): "paused" | "requested" {
    const run = this.requireRun(runId);
    if (!isActive(run.state)) throw new Error(`Run ${runId} is ${run.state}; nothing to pause.`);
    if (this.store.acquireLock(runId)) {
      try {
        const cur = this.requireRun(runId);
        if (!isActive(cur.state)) throw new Error(`Run ${runId} is ${cur.state}; nothing to pause.`);
        this.stopRun(runId, State.PAUSED, "Operator requested pause.");
      } finally {
        this.store.releaseLock(runId);
      }
      return "paused";
    }
    this.store.setCounter(runId, PAUSE_REQUEST, this.store.now());
    return "requested";
  }

  /**
   * Forced stop: terminate the active session's process tree, preserve the
   * partial work as evidence, and enter reconciliation (Section 10). With a
   * live controller, it observes the request and records the stop itself.
   */
  async stop(runId: string): Promise<"stopped" | "requested"> {
    const run = this.requireRun(runId);
    if (!isActive(run.state) && !isOrthogonal(run.state)) throw new Error(`Run ${runId} is ${run.state}; nothing to stop.`);
    if (this.store.acquireLock(runId)) {
      try {
        const open = this.store.openSessions(runId);
        for (const s of open) if (await this.pi.isRunning(ref(s))) await this.pi.terminate(ref(s));
        const cur = this.requireRun(runId);
        const git = this.makeGit(cur.repoPath);
        const evidence = open.map((s) => this.preserveInterrupted(cur, git, s));
        this.store.tx(() => {
          for (const s of open) this.retireSession(s.rowId, "stopped");
          this.store.deleteCounter(runId, STOP_REQUEST);
          this.stopRun(runId, State.RECONCILIATION,
            `Operator stopped the run${evidence.length ? `; partial changes preserved at ${evidence.join(", ")}` : ""}. ` +
              `Inspect the checkout, then 'qfb resume ${runId}'.`);
        });
      } finally {
        this.store.releaseLock(runId);
      }
      return "stopped";
    }
    this.store.setCounter(runId, STOP_REQUEST, this.store.now());
    for (const s of this.store.openSessions(runId)) await this.pi.terminate(ref(s));
    return "requested";
  }

  /**
   * Reconcile and continue: leave an orthogonal state back to the phase that
   * was interrupted. Refuses while any earlier session is still running.
   * Resuming a FAILED run is an explicit operator retry: it re-opens failed
   * steps and grants a fresh, audited budget window (budgets are never reset
   * merely because a controller restarts).
   */
  async resume(runId: string, opts: { acceptUnscannable?: boolean } = {}): Promise<StateName> {
    if (!this.store.acquireLock(runId)) throw new Error(this.lockedMessage(runId));
    try {
      const run = this.requireRun(runId);
      if (!isOrthogonal(run.state)) throw new Error(`Run ${runId} is ${run.state}; nothing to resume.`);
      if (this.designChanged(runId)) {
        this.stopRun(runId, State.PAUSED, DESIGN_CHANGED);
        throw new Error(`${DESIGN_CHANGED} Review the edited design, then 'qfb approve ${runId}'.`);
      }
      // The operator vouches for files the confidentiality scan could not read:
      // exactly the content the gate saw (path + digest), nothing later.
      const vetted = opts.acceptUnscannable ? this.unscannableList(runId, UNSCANNABLE_PENDING) : [];
      if (opts.acceptUnscannable && vetted.length === 0) {
        throw new Error(`Run ${runId} has no unscannable files awaiting a decision.`);
      }
      const open = this.store.openSessions(runId);
      for (const s of open) {
        if (await this.pi.isRunning(ref(s))) {
          throw new Error(
            `Session ${s.sessionId} (pid ${s.pid} on ${s.host}) is still running; wait for it to exit or 'qfb stop ${runId}' first.`,
          );
        }
      }
      const git = this.makeGit(run.repoPath);
      const evidence = open.map((s) => this.preserveInterrupted(run, git, s));
      const target = this.resumeStateOf(runId);
      const retry = run.state === State.FAILED;
      this.store.tx(() => {
        for (const s of open) this.retireSession(s.rowId, "interrupted");
        this.reopenSteps(runId);
        if (retry) {
          this.store.setNumber(runId, BUDGET_EPOCH, this.store.maxSessionRowId(runId));
          this.store.deleteCounter(runId, "finding-identity-history");
          this.store.deleteCounter(runId, "bug-identity-history");
        }
        this.store.deleteCounter(runId, PAUSE_REQUEST);
        this.store.deleteCounter(runId, STOP_REQUEST);
        if (vetted.length > 0) {
          const accepted = this.unscannableList(runId, UNSCANNABLE_ACCEPTED);
          this.store.setCounter(runId, UNSCANNABLE_ACCEPTED, JSON.stringify([...accepted, ...vetted]));
          this.store.deleteCounter(runId, UNSCANNABLE_PENDING);
        }
        this.store.setStopReason(runId, null);
        this.transition(runId, run.state, target, retry ? "operator-retry" : "operator-resume",
          JSON.stringify({
            previousStopReason: run.stopReason,
            evidence,
            ...(vetted.length > 0 ? { vettedUnscannable: vetted } : {}),
          }));
      });
      return target;
    } finally {
      this.store.releaseLock(runId);
    }
  }

  // ---------------------------------------------------------------- clean
  /**
   * What `clean` deletes: the run's row (null if unknown) and its existing
   * artifact directories. Read-only. A run started under another
   * QFB_ARTIFACTS keeps its files there, so the paths QFB recorded are
   * followed too, but only into a directory named for this run.
   */
  cleanTargets(runId: string): { run: RunRow | null; paths: string[] } {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run id ${JSON.stringify(runId)}.`);
    const run = this.store.getRun(runId);
    const dirs = new Set([join(this.artifactRoot, runId)]);
    if (run) {
      const recorded = [
        this.store.getCounter(runId, "prepared-plan-path"),
        ...this.store.getSessions(runId).map((s) => s.artifact_path as string | null),
      ];
      for (const p of recorded) if (p && basename(dirname(p)) === runId) dirs.add(dirname(p));
    }
    return { run, paths: [...dirs].filter((d) => existsSync(d)) };
  }

  /**
   * Delete everything QFB keeps for a run: its rows in every state-store table
   * and its artifact directory (plan manifest, task artifacts, transcripts, Pi
   * session files, test logs, review/fix reports, interrupted-session patches).
   * Never touches the checkout or its commits. Refuses while a controller holds
   * the run or one of its sessions may still be running. Re-running finishes an
   * interrupted clean: leftover files are removed once the rows are gone.
   */
  async clean(runId: string): Promise<{ existed: boolean; rows: number; removed: string[]; scrubbed: boolean }> {
    const leftover = this.cleanTargets(runId);
    if (!leftover.run) {
      if (leftover.paths.length === 0) throw new Error(`Unknown run ${runId}`);
      for (const p of leftover.paths) rmSync(p, { recursive: true, force: true });
      // The earlier clean deleted (and reported on scrubbing) the rows.
      return { existed: false, rows: 0, removed: leftover.paths, scrubbed: true };
    }
    if (!this.store.acquireLock(runId)) throw new Error(`${this.lockedMessage(runId)} Stop it before cleaning.`);
    let targets: { paths: string[] };
    let deleted: { rows: number; scrubbed: boolean };
    try {
      for (const s of this.store.openSessions(runId)) {
        if (await this.pi.isRunning(ref(s))) {
          throw new Error(
            `Session ${s.sessionId} (pid ${s.pid} on ${s.host}) is still running; 'qfb stop ${runId}' first, or wait for it to exit.`,
          );
        }
      }
      targets = this.cleanTargets(runId);
      // Rows before files: a failed file removal is finished by re-running clean,
      // whereas a live run with missing artifacts would lose its evidence and
      // its regression suite.
      deleted = this.store.deleteRun(runId);
    } finally {
      this.store.releaseLock(runId);
    }
    for (const p of targets.paths) rmSync(p, { recursive: true, force: true });
    return { existed: true, ...deleted, removed: targets.paths };
  }

  status(runId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const steps = this.store.getSteps(runId);
    const requests = [PAUSE_REQUEST, STOP_REQUEST].filter((k) => this.store.getCounter(runId, k) !== null);
    return {
      runId,
      state: run.state,
      approved: run.approved,
      repoPath: run.repoPath,
      branch: run.branch,
      baseRef: run.baseRef,
      baseSpec: run.baseSpec,
      stopReason: run.stopReason,
      resumeTo: isOrthogonal(run.state) ? this.resumeStateOf(runId) : null,
      pendingRequests: requests.map((k) => k.replace("request-", "")),
      unscannablePending: this.unscannableList(runId, UNSCANNABLE_PENDING).map((f) => f.path),
      preparedPlanPath: this.store.getCounter(runId, "prepared-plan-path"),
      planStrategy: this.store.getCounter(runId, "plan-strategy"),
      planAmbiguous: this.store.getCounter(runId, PLAN_AMBIGUOUS) !== null,
      steps: steps.map((s) => ({ id: s.id, status: s.status, attempts: s.attempts, text: s.text.split("\n")[0] })),
      stepsDone: steps.filter((s) => s.status === "done").length,
      stepsTotal: steps.length,
      sessionCount: this.store.getSessionCount(runId),
      reviews: this.store.getReviews(runId).length,
      checkpoints: this.store.getCheckpoints(runId).length,
    };
  }

  /** The candidate the final review accepted (null unless COMPLETED). */
  acceptedCandidate(runId: string): AcceptedCandidate | null {
    const v = this.store.getCounter(runId, ACCEPTED);
    return v ? (JSON.parse(v) as AcceptedCandidate) : null;
  }

  /**
   * Extra, human-oriented detail for `status --verbose`: the current/last Pi
   * session (id, kind, step, status, transcript path) and the recent phase
   * transitions with timestamps.
   */
  statusDetails(runId: string, transitionLimit = 12): {
    currentSession: {
      sessionId: string;
      kind: string;
      stepId: string;
      status: string | null;
      startedAt: string | null;
      endedAt: string | null;
      transcriptPath: string | null;
    } | null;
    recentTransitions: { at: string; from: string | null; to: string; operation: string }[];
  } {
    this.requireRun(runId);
    const s = this.store.getLatestSession(runId);
    const artifactPath = (s?.artifact_path as string | undefined) ?? null;
    const currentSession = s
      ? {
          sessionId: s.session_id as string,
          kind: s.kind as string,
          stepId: s.step_id as string,
          status: (s.status as string | null) ?? null,
          startedAt: (s.started_at as string | null) ?? null,
          endedAt: (s.ended_at as string | null) ?? null,
          transcriptPath: artifactPath ? `${artifactPath}.transcript.log` : null,
        }
      : null;
    const recentTransitions = this.store
      .getTransitions(runId)
      .slice(-transitionLimit)
      .map((t) => ({
        at: t.created_at as string,
        from: (t.from_state as string | null) ?? null,
        to: t.to_state as string,
        operation: t.operation as string,
      }));
    return { currentSession, recentTransitions };
  }

  // ---------------------------------------------------------------- sessions
  /**
   * Crash-resume: an ended session whose outcome was never acted on is
   * re-processed instead of relaunched. Consumed sessions are never replayed.
   */
  private unconsumed(runId: string, kind: string, stepId: string): Obtained | null {
    const row = this.store.latestSession(runId, kind, stepId);
    if (!row || row.consumedAt || !row.endedAt) return null;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(row.artifactPath, "utf8"));
    } catch {
      raw = null;
    }
    const { artifact, problem } = checkArtifact(raw, this.expectedArtifact(row));
    this.inflight = row.rowId;
    const run = this.requireRun(runId);
    return {
      row,
      problem,
      before: row.gitBefore ?? this.makeGit(run.repoPath).snapshot(run.baseRef),
      result: {
        sessionId: row.sessionId,
        settled: row.exitCode !== null,
        exitCode: row.exitCode,
        timedOut: row.timedOut,
        artifact,
        transcriptPath: `${row.artifactPath}.transcript.log`,
      },
    };
  }

  /** Record and launch one fresh agent session. */
  private async launchSession(
    run: RunRow,
    git: GitLike,
    o: { kind: string; stepId: string; sessionId: string; artifactPath: string; label: PaneLabel; prompt: string },
  ): Promise<Obtained> {
    const before = git.snapshot(run.baseRef);
    // Never let a leftover file masquerade as this session's artifact.
    if (existsSync(o.artifactPath)) renameSync(o.artifactPath, `${o.artifactPath}.stale-${Date.now()}`);
    const pane = await this.herdr.ensurePane(o.label);
    const rowId = this.store.recordSession(run.id, o.stepId, o.kind, o.sessionId, pane, o.artifactPath, before);
    this.inflight = rowId;
    const result = await this.pi.launch({
      runId: run.id,
      stepId: o.stepId,
      cwd: run.repoPath,
      sessionId: o.sessionId,
      artifactPath: o.artifactPath,
      sessionDir: this.artifactPath(run.id, "pi-sessions"),
      inactivityTimeoutMs: run.config.sessionInactivityTimeoutMs,
      prompt: o.prompt,
      onSpawn: (pid) => this.store.setSessionPid(rowId, pid, hostname()),
    });
    const { artifact, problem } = checkArtifact(result.artifact, this.expectedArtifact(this.store.getSession(rowId)!));
    const stopped = this.store.getCounter(run.id, STOP_REQUEST) !== null;
    const status = stopped ? "stopped" : artifact?.status ?? (result.settled ? "unknown" : "aborted");
    this.store.endSession(rowId, status, result.settled ? result.exitCode ?? 0 : null, result.timedOut);
    if (stopped) this.haltForStop(run.id, rowId);
    return { result: { ...result, artifact }, row: this.store.getSession(rowId)!, before, problem };
  }

  /** The identity a session's artifact must carry (H6): this run, step, kind, and written after it started. */
  private expectedArtifact(row: SessionRow): ExpectedArtifact {
    return {
      runId: row.runId,
      stepId: row.stepId,
      kind: ARTIFACT_KIND[row.kind] ?? (row.kind as TaskArtifact["kind"]),
      startedAt: row.startedAt,
    };
  }

  // ---------------------------------------------------------------- gate evidence
  /**
   * Git-derived evidence for a writer gate. A git failure throws GitError and
   * pauses the run: neither the agent's self-reported files nor an empty diff
   * is ever substituted. Unscannable files an operator already vetted (same
   * path, same content digest) are not reported again.
   */
  private writerEvidence(run: RunRow, git: GitLike): { changedFiles: string[]; added: AddedContent } {
    const added = git.addedContent(run.baseRef);
    const vetted = this.unscannableList(run.id, UNSCANNABLE_ACCEPTED);
    return {
      changedFiles: git.changedFiles(run.baseRef),
      added: {
        files: added.files,
        unscannable: added.unscannable.filter((u) => !vetted.some((v) => v.path === u.path && v.digest === u.digest)),
      },
    };
  }

  private unscannableList(runId: string, key: string): UnscannableFile[] {
    const v = this.store.getCounter(runId, key);
    return v ? (JSON.parse(v) as UnscannableFile[]) : [];
  }

  /** Remember what the latest gate could not scan, for 'resume --accept-unscannable'. */
  private noteUnscannable(runId: string, files: UnscannableFile[]): void {
    if (files.length > 0) this.store.setCounter(runId, UNSCANNABLE_PENDING, JSON.stringify(files));
    else this.store.deleteCounter(runId, UNSCANNABLE_PENDING);
  }

  /**
   * The outcome is acceptable except for files the confidentiality scan could
   * not read: pause for a human to vet them, keeping the outcome so that it is
   * re-gated (not relaunched) once they have decided.
   */
  private holdForVetting(runId: string, files: UnscannableFile[], what: string): void {
    this.holdOutcome(runId);
    this.stopRun(runId, State.PAUSED,
      `${what}: ${files.length} changed file(s) cannot be scanned for deny-listed terms: ` +
        `${files.map((f) => `${f.path} (${f.reason})`).join(", ")}. Check them by hand; if they are clean, ` +
        `'qfb resume ${runId} --accept-unscannable'; otherwise remove them and 'qfb resume ${runId}'.`);
  }

  /**
   * Keep the in-flight session's outcome unconsumed across the coming pause,
   * so resuming re-processes it instead of launching a new session. Only when
   * resuming returns to the same handler (a paused FIXING resumes into a fresh
   * REVIEWING, which would orphan a held fix outcome).
   */
  private holdOutcome(runId: string): void {
    const state = this.requireRun(runId).state;
    if (resumeTarget(state) === state) this.inflight = null;
  }

  /**
   * Restart reconciliation (Section 9). A session the previous controller
   * never saw end is either still running — then we refuse to start another
   * writer and enter reconciliation — or provably gone: its partial work is
   * preserved as evidence and left in place, the session is retired, and the
   * phase continues with a fresh, informed attempt.
   */
  private async reconcileInflight(runId: string): Promise<void> {
    const open = this.store.openSessions(runId);
    if (open.length === 0) return;
    for (const s of open) {
      const deadline = Date.now() + this.orphanGraceMs;
      while ((await this.pi.isRunning(ref(s))) && Date.now() < deadline) await sleep(250);
      if (await this.pi.isRunning(ref(s))) {
        const msg =
          `Session ${s.sessionId} (pid ${s.pid} on ${s.host}) from an earlier controller is still running; ` +
          `refusing to start a second writer. Let it finish (or 'qfb stop ${runId}'), then 'qfb resume ${runId}'.`;
        this.stopRun(runId, State.RECONCILIATION, msg);
        throw new HaltSignal(msg);
      }
    }
    const run = this.requireRun(runId);
    const git = this.makeGit(run.repoPath);
    const evidence = open.map((s) => this.preserveInterrupted(run, git, s));
    this.store.tx(() => {
      for (const s of open) this.retireSession(s.rowId, "interrupted");
      if (isActive(run.state)) {
        this.transition(runId, run.state, State.RECONCILIATION, "interrupted-session",
          JSON.stringify({ sessions: open.map((s) => s.sessionId), evidence }));
        this.transition(runId, State.RECONCILIATION, resumeTarget(run.state), "auto-reconciled",
          "in-flight session(s) no longer running; partial changes preserved and left in the working tree");
      }
    });
  }

  /** Persist a forced stop observed by the live controller, then unwind. */
  private haltForStop(runId: string, rowId: number | null): never {
    const run = this.requireRun(runId);
    const s = rowId !== null ? this.store.getSession(rowId) : null;
    const evidence = s ? this.preserveInterrupted(run, this.makeGit(run.repoPath), s) : null;
    this.store.tx(() => {
      if (s) this.store.consumeSession(s.rowId);
      this.inflight = null;
      this.store.deleteCounter(runId, STOP_REQUEST);
      this.stopRun(runId, State.RECONCILIATION,
        `Operator forced stop${s ? ` during session ${s.sessionId}; partial changes preserved at ${evidence}` : ""}. ` +
          `Inspect the checkout, then 'qfb resume ${runId}'.`);
    });
    throw new HaltSignal("stopped");
  }

  /** Re-open blocked/failed steps so the loop retries them instead of skipping ahead. */
  private reopenSteps(runId: string): void {
    for (const s of this.store.getSteps(runId)) {
      if (s.status === "blocked" || s.status === "failed") this.store.setStepStatus(runId, s.id, "pending");
    }
  }

  private retireSession(rowId: number, status: string): void {
    const s = this.store.getSession(rowId);
    if (s && !s.endedAt) this.store.endSession(rowId, status, null, false);
    this.store.consumeSession(rowId);
  }

  /** Save the working-tree state an interrupted session left behind. Never modifies the checkout. */
  private preserveInterrupted(run: RunRow, git: GitLike, s: SessionRow): string {
    const path = `${s.artifactPath}.interrupted.patch`;
    const files = evidenceText(() => git.changedFiles(run.baseRef).join("\n"));
    const diff = evidenceText(() => git.workingDiff(run.baseRef));
    writeFileSync(path, `# session ${s.sessionId} interrupted\n# changed vs ${run.baseRef}:\n${files}\n\n${diff}\n`);
    return path;
  }

  // ---------------------------------------------------------------- tests
  /** Re-run each claimed validation command, one at a time, capturing the REAL exit code. */
  private async verifyTests(run: RunRow, a: TaskArtifact, row: SessionRow): Promise<VerifiedTest[]> {
    const out: VerifiedTest[] = [];
    for (let i = 0; i < a.testCommands.length; i++) {
      const t = a.testCommands[i]!;
      const logPath = `${row.artifactPath}.verify-${i + 1}.log`;
      const exitCode = await this.runTest(t.command, run.repoPath, logPath, run.config.testTimeoutMs);
      out.push({ command: t.command, claimedExitCode: t.exitCode, exitCode, logPath });
    }
    return out;
  }

  private suitePath(runId: string): string {
    return this.artifactPath(runId, "regression-suite.json");
  }

  /** Accumulate every verified command; all must pass on the final candidate. */
  private rememberTests(runId: string, verified: VerifiedTest[]): void {
    const suite = this.readSuite(runId);
    for (const t of verified) if (!suite.includes(t.command)) suite.push(t.command);
    writeFileSync(this.suitePath(runId), JSON.stringify(suite, null, 2) + "\n");
  }

  private readSuite(runId: string): string[] {
    try {
      const v = JSON.parse(readFileSync(this.suitePath(runId), "utf8"));
      return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
    } catch {
      return [];
    }
  }

  private async runRegressionSuite(run: RunRow, row: SessionRow): Promise<VerifiedTest[]> {
    const out: VerifiedTest[] = [];
    const suite = this.readSuite(run.id);
    for (let i = 0; i < suite.length; i++) {
      const logPath = `${row.artifactPath}.final-${i + 1}.log`;
      const exitCode = await this.runTest(suite[i]!, run.repoPath, logPath, run.config.testTimeoutMs);
      out.push({ command: suite[i]!, claimedExitCode: 0, exitCode, logPath });
    }
    return out;
  }

  // ---------------------------------------------------------------- helpers
  /** Commit-policy checkpoint of the gated tree; returns the checkpoint HEAD. */
  private checkpointCommit(run: RunRow, git: GitLike, label: string, summary: string): string {
    if (run.config.checkpointPolicy !== "commit") return git.head();
    let msg = `[qfb] ${label}: ${summary.split("\n")[0] ?? ""}`.slice(0, 72).trim();
    // Commit messages leave the machine with a push: keep deny-listed names out.
    if (scanForDenyTerms(msg, run.denyList).length > 0) msg = `[qfb] ${label} checkpoint`;
    return git.commitAll(msg);
  }

  private sessionsSinceEpoch(runId: string, f: { kind?: string; stepId?: string } = {}): number {
    return this.store.countSessions(runId, { ...f, sinceRowId: this.store.getNumber(runId, BUDGET_EPOCH) });
  }

  /** The phase to return to: derived from the last transition out of an active state. */
  private resumeStateOf(runId: string): StateName {
    const ts = this.store.getTransitions(runId);
    for (let i = ts.length - 1; i >= 0; i--) {
      const from = ts[i]!.from_state as StateName | null;
      const to = ts[i]!.to_state as StateName;
      if (from && isActive(from) && isOrthogonal(to)) return resumeTarget(from);
    }
    return State.READY;
  }

  private stopRun(runId: string, state: StateName, reason: string): StateName {
    this.store.tx(() => {
      const run = this.requireRun(runId);
      this.store.setStopReason(runId, reason);
      if (state === State.PAUSED) this.store.deleteCounter(runId, PAUSE_REQUEST);
      if (run.state !== state) this.transition(runId, run.state, state, "stop", reason);
      if (this.inflight !== null) {
        this.store.consumeSession(this.inflight);
        this.inflight = null;
      }
    });
    return state;
  }

  private designChanged(runId: string): boolean {
    const run = this.requireRun(runId);
    if (!existsSync(run.designPath)) return false;
    return sha256(readFileSync(run.designPath, "utf8")) !== run.designHash;
  }

  /**
   * Validated, compare-and-set state change. Fails loudly if the persisted
   * state is not `from` (another actor changed it), instead of overwriting it.
   * Consumes the in-flight session outcome in the same transaction.
   */
  private transition(runId: string, from: StateName, to: StateName, op: string, evidence?: string): void {
    assertTransition(from, to);
    this.store.tx(() => {
      if (!this.store.casState(runId, from, to)) {
        const cur = this.store.getRun(runId)?.state;
        throw new Error(`State conflict on ${runId}: expected ${from}, found ${cur}; refusing ${from} -> ${to}.`);
      }
      if (this.inflight !== null) {
        this.store.consumeSession(this.inflight);
        this.inflight = null;
      }
      this.store.recordTransition(runId, from, to, op, evidence);
    });
  }

  private withRunLock<T>(runId: string, fn: () => T): T {
    if (!this.store.acquireLock(runId)) throw new Error(this.lockedMessage(runId));
    try {
      return fn();
    } finally {
      this.store.releaseLock(runId);
    }
  }

  private lockedMessage(runId: string): string {
    const h = this.store.lockHolder(runId);
    return `Run ${runId} is locked by another controller instance${h ? ` (pid ${h.pid} on ${h.host})` : ""}.`;
  }

  private requireRun(runId: string): RunRow {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    return run;
  }

  private artifactDir(runId: string): string {
    const dir = join(this.artifactRoot, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private artifactPath(runId: string, name: string): string {
    return join(this.artifactDir(runId), name);
  }

  private priorFailures(runId: string, key: string): string[] {
    const v = this.store.getCounter(runId, key);
    return v ? (JSON.parse(v) as string[]) : [];
  }

  private static readonly COMMON_RULES = [
    `- Do NOT stage, commit, reset, rebase, or switch branches; QFB owns checkpoints and verifies HEAD is unchanged.`,
    `- Never run concurrent Maven invocations. Treat java-questdb-client/ as a separate repo.`,
    `- List EVERY validation command you ran in testCommands, as the exact command line run from the repository root.`,
    `  QFB re-runs each one itself and gates on the REAL exit code; a claimed exit code that differs rejects the result.`,
  ];

  /** The identity fields QFB checks on every artifact (a mismatch rejects it). */
  private static identity(runId: string, stepId: string, kind: TaskArtifact["kind"]): string[] {
    return [
      `  Identify it with runId:"${runId}", stepId:"${stepId}", kind:"${kind}", and createdAt set to the current UTC`,
      `  time in ISO-8601 (run \`date -u +%Y-%m-%dT%H:%M:%SZ\`); QFB rejects an artifact that does not match this session.`,
    ];
  }

  private buildStepPrompt(
    run: RunRow,
    step: { id: string; text: string },
    done: string[],
    artifactPath: string,
    attempt: number,
  ): string {
    const prior = this.priorFailures(run.id, `gate-failures:${step.id}`);
    return [
      `You are implementing ONE step of an approved QuestDB feature plan.`,
      `First read CLAUDE.md and the approved design at: ${run.designPath}`,
      `Completed steps: ${done.length ? done.join(", ") : "(none)"}`,
      ``,
      `## Assigned step ${step.id}`,
      step.text,
      ``,
      ...(attempt > 1
        ? [
            `This is attempt ${attempt}. The working tree may contain partial changes from an earlier, interrupted or`,
            `rejected attempt of this step: inspect \`git status\` / \`git diff\` and build on them; do not discard them.`,
            ...(prior.length ? [`The previous attempt was rejected by QFB's mechanical gate: ${prior.join("; ")}`] : []),
            ``,
          ]
        : []),
      `Rules:`,
      `- Implement ONLY this step and its tests. Do NOT start another step.`,
      `- Do NOT change the architecture, requirements, or other plan steps.`,
      ...Controller.COMMON_RULES,
      `- When done, write a typed JSON TaskArtifact to: ${artifactPath}`,
      `  with fields: {runId, stepId, kind, status, summary, changedFiles[],`,
      `  testCommands[{command,exitCode}], limitations[], notableDecisions[], createdAt}.`,
      ...Controller.identity(run.id, step.id, "implementation"),
      `- status MUST be one of DONE | BLOCKED | NEEDS_DECISION | FAILED.`,
    ].join("\n");
  }

  private buildHardeningPrompt(run: RunRow, stage: StateName, stepId: string, artifactPath: string, failuresKey: string): string {
    const gaps = this.store.getCounter(run.id, "hardening-gap-artifact");
    const bugDoc = this.store.getCounter(run.id, "hardening-bug-artifact");
    const openBugs = this.store.getCounter(run.id, "open-bugs") ?? "[]";
    const prior = this.priorFailures(run.id, failuresKey);
    const what =
      stage === State.HARDENING_IDENTIFY
        ? [
            `Analyze the cumulative feature diff (vs ${run.baseRef}) and the existing tests; write a prioritized coverage-gap`,
            `handoff (fuzz, concurrency, edge cases, integration, fault injection) to ${artifactPath}.gaps.md and set handoffPath.`,
            `This stage is READ-ONLY: do NOT modify any file in the checkout (QFB verifies the tree is unchanged).`,
          ]
        : stage === State.HARDENING_WRITE_TESTS
        ? [
            `Implement the tests described in the coverage-gap handoff at ${gaps} (and its handoffPath document).`,
            `If a test exposes a real bug, record it in bugs[] (stable id, location, repro, failingTest, observed, expected)`,
            `and keep the failing test — do NOT weaken or delete it. A failing test command is only accepted when the bug it`,
            `exposes is recorded. Put a detailed bug handoff in ${artifactPath}.bugs.md and set handoffPath.`,
          ]
        : [
            `Fix the defects (not the tests) for these open bugs, recorded in ${bugDoc}:`,
            openBugs,
            `Validate that the previously failing tests now pass without regressions. In bugs[], list ONLY the bugs that are`,
            `still open after your work (an empty array when all are fixed). Set fixOutcome: Clean | Blocked | Diverging | Exhausted.`,
          ];
    return [
      `Phase C test-coverage hardening stage: ${stage}.`,
      `Read CLAUDE.md and the approved design at: ${run.designPath}`,
      ...what,
      ...(prior.length ? [`The previous attempt was rejected by QFB's mechanical gate: ${prior.join("; ")}`] : []),
      `Rules:`,
      ...Controller.COMMON_RULES,
      `Write a typed JSON TaskArtifact to ${artifactPath} with status DONE | BLOCKED | NEEDS_DECISION | FAILED`,
      `and fields {runId, stepId, kind, status, summary, changedFiles[], testCommands[{command,exitCode}], limitations[],`,
      `notableDecisions[], bugs[], handoffPath, createdAt}.`,
      ...Controller.identity(run.id, stepId, stage === State.HARDENING_IDENTIFY ? "coverage-gap" : "bug"),
    ].join("\n");
  }

  private buildReviewPrompt(run: RunRow, artifactPath: string): string {
    return [
      `Run QuestDB's review-pr skill on the cumulative feature diff.`,
      `Invoke: /skill:review-pr --range=${run.baseRef}.. --level=${run.config.reviewLevel}`,
      `This session is READ-ONLY: do NOT modify any file in the checkout (QFB verifies the tree is unchanged).`,
      `Write the COMPLETE raw report to ${artifactPath}.report.md and set reviewReportPath to that path.`,
      `The report MUST contain exactly ONE machine-readable fenced \`\`\`qfb-review JSON block (never quote or`,
      `repeat it) with {verdict, testGatePassed, findings:[{id,severity,location,evidence}]}; finding ids must be unique.`,
      `Write a typed JSON TaskArtifact (status DONE) to ${artifactPath}.`,
      ...Controller.identity(run.id, "review", "review"),
    ].join("\n");
  }

  private buildFixPrompt(run: RunRow, findings: unknown, artifactPath: string): string {
    return [
      `Run QuestDB's fix-pr skill against these authorized findings:`,
      JSON.stringify(findings, null, 2),
      `Preserve finding IDs, severities, context, and evidence.`,
      `Rules:`,
      ...Controller.COMMON_RULES,
      `Report the skill's distinct outcome in fixOutcome: Clean | Blocked | Diverging | Exhausted.`,
      `Write a typed JSON TaskArtifact (status DONE unless blocked) to ${artifactPath}.`,
      ...Controller.identity(run.id, "fix", "fix"),
    ].join("\n");
  }
}

function ref(s: SessionRow): SessionRef {
  return { sessionId: s.sessionId, pid: s.pid, host: s.host };
}

/** Lock key for a checkout, so two runs can never write the same tree. */
function repoLockKey(repoPath: string): string {
  let p: string;
  try {
    p = realpathSync(repoPath);
  } catch {
    p = resolve(repoPath);
  }
  return `repo:${p}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

/** Evidence text that must never fail the operation that records it. */
function evidenceText(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    return `(unavailable: ${(e as Error).message})`;
  }
}

export async function writeArtifactFile(path: string, artifact: TaskArtifact): Promise<void> {
  await writeFile(path, JSON.stringify(artifact, null, 2));
}
