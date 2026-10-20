import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.ts";
import { assertTransition } from "./stateMachine.ts";
import { extractPlan } from "./plan.ts";
import { mechanicalGate } from "./gating.ts";
import { parseReviewReport, selectActionableFindings, isAcceptable, AmbiguousReportError } from "./report.ts";
import { findingIdentity, bugIdentity, detectNoProgress } from "./identity.ts";
import { Git } from "./git.ts";
import { State, AgentStatus, FixOutcome, DEFAULT_CONFIG } from "./types.ts";
import type { PiAdapter } from "./adapters/pi.ts";
import type { HerdrAdapter } from "./adapters/herdr.ts";
import type { RunConfig, StateName, TaskArtifact, GitSnapshot } from "./types.ts";

/** Minimal Git surface the controller depends on (injectable for tests). */
export interface GitLike {
  branch(): string;
  head(): string;
  snapshot(base: string): GitSnapshot;
  stagedDiff(): string;
  isClean(): boolean;
  commitCheckpoint(message: string, files: string[]): string;
}

export interface ControllerDeps {
  store: Store;
  pi: PiAdapter;
  herdr: HerdrAdapter;
  /** Factory so each run targets its own checkout; defaults to real Git. */
  makeGit?: (repoPath: string) => GitLike;
  /** Root directory for durable artifacts (outside the QuestDB tree). */
  artifactRoot: string;
}

export interface InitOptions {
  repoPath: string;
  designPath: string;
  base: string;
  config?: Partial<RunConfig>;
  denyList?: string[];
}

export class PauseSignal extends Error {}

export class Controller {
  private readonly store: Store;
  private readonly pi: PiAdapter;
  private readonly herdr: HerdrAdapter;
  private readonly makeGit: (repoPath: string) => GitLike;
  private readonly artifactRoot: string;

  constructor(deps: ControllerDeps) {
    this.store = deps.store;
    this.pi = deps.pi;
    this.herdr = deps.herdr;
    this.makeGit = deps.makeGit ?? ((p) => new Git(p));
    this.artifactRoot = deps.artifactRoot;
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
    const extraction = extractPlan(design);

    const git = this.makeGit(opts.repoPath);
    const config: RunConfig = { ...DEFAULT_CONFIG, ...opts.config };

    this.store.createRun({
      id: runId,
      repoPath: opts.repoPath,
      branch: git.branch(),
      baseRef: opts.base,
      designPath: opts.designPath,
      designHash,
      config,
      state: State.CREATED,
      approved: false,
      denyList: opts.denyList ?? [],
      stopReason: null,
    });
    this.store.recordTransition(runId, null, State.CREATED, "init");

    // --- Preparation phase ---
    this.transition(runId, State.CREATED, State.PREPARING, "prepare");
    const preparedPlanPath = this.artifactPath(runId, "prepared-plan.md");
    const header =
      `<!-- QFB prepared plan for ${runId} -->\n` +
      `<!-- source design/handoff: ${opts.designPath} -->\n` +
      `<!-- approve with: qfb approve ${runId} -->\n\n`;
    writeFileSync(preparedPlanPath, header + extraction.normalizedMarkdown);
    this.store.setCounter(runId, "prepared-plan-path", preparedPlanPath);
    this.store.setCounter(runId, "plan-strategy", extraction.strategy);
    this.store.insertSteps(runId, extraction.steps);

    this.transition(runId, State.PREPARING, State.AWAITING_APPROVAL, "prepared",
      JSON.stringify({ strategy: extraction.strategy, steps: extraction.steps.length }));

    return {
      runId,
      ambiguous: extraction.ambiguous,
      notes: extraction.notes,
      steps: extraction.steps.length,
      strategy: extraction.strategy,
      preparedPlanPath,
    };
  }

  approve(runId: string): void {
    const run = this.requireRun(runId);
    if (run.state !== State.AWAITING_APPROVAL && run.state !== State.PAUSED) {
      throw new Error(`Run ${runId} is not awaiting approval (state=${run.state}).`);
    }
    // Re-freeze design hash on (re-)approval.
    const design = readFileSync(run.designPath, "utf8");
    this.store.setDesignHash(runId, sha256(design));
    this.store.setApproved(runId);
    this.store.setStopReason(runId, null);
    this.transition(runId, run.state, State.READY, "approve");
  }

  // ---------------------------------------------------------------- run loop
  /**
   * Execute the workflow to the next natural stopping point. Acquires the
   * exclusive run lock; drives deterministic `advance()` calls until the run
   * reaches a terminal, paused, blocked, or failed state.
   */
  async run(runId: string): Promise<StateName> {
    if (!this.store.acquireLock(runId)) {
      throw new Error(`Run ${runId} is locked by another controller instance.`);
    }
    try {
      // Design-integrity reconciliation (Section 5 / Section 14).
      this.checkDesignIntegrity(runId);
      let guard = 0;
      while (guard++ < 10_000) {
        const run = this.requireRun(runId);
        if ([State.COMPLETED, State.FAILED, State.PAUSED, State.BLOCKED].includes(run.state as never)) {
          return run.state;
        }
        if (this.store.getSessionCount(runId) >= run.config.maxTotalSessions) {
          return this.stopRun(runId, State.FAILED, "Hard ceiling on total Pi sessions reached.");
        }
        await this.advance(runId);
      }
      throw new Error("Run loop exceeded guard limit.");
    } catch (e) {
      if (e instanceof PauseSignal) {
        const cur = this.requireRun(runId).state;
        if (cur !== State.PAUSED) this.transition(runId, cur, State.PAUSED, "pause", e.message);
        this.store.setStopReason(runId, e.message);
        return State.PAUSED;
      }
      throw e;
    } finally {
      this.store.releaseLock(runId);
    }
  }

  /** One deterministic controller decision based solely on persisted state. */
  private async advance(runId: string): Promise<void> {
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
      case State.VERIFYING_FIX:
        this.transition(runId, State.VERIFYING_FIX, State.REVIEWING, "fix-verified");
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

    this.store.setStepStatus(runId, next.id, "active");
    const attempts = this.store.incStepAttempts(runId, next.id);
    const git = this.makeGit(run.repoPath);
    const before = git.snapshot(run.baseRef);

    const completed = steps.filter((s) => s.status === "done").map((s) => s.id);
    const artifactPath = this.artifactPath(runId, `${next.id}-attempt${attempts}.json`);
    const sessionId = `${runId}-${next.id}-a${attempts}`;

    const pane = await this.herdr.ensurePane({ feature: runId, phase: "IMPLEMENTING", stepId: next.id });
    const sessionRow = this.store.recordSession(runId, next.id, "implementation", sessionId, pane, artifactPath);

    const result = await this.pi.launch({
      runId,
      stepId: next.id,
      cwd: run.repoPath,
      sessionId,
      artifactPath,
      inactivityTimeoutMs: run.config.sessionInactivityTimeoutMs,
      prompt: this.buildStepPrompt(run.designPath, next, completed, artifactPath),
    });
    this.store.endSession(sessionRow, result.artifact?.status ?? "unknown");

    const after = git.snapshot(run.baseRef);
    const gate = mechanicalGate({
      artifact: result.artifact,
      sessionCompleted: result.settled && !result.timedOut,
      before,
      after,
      expectedBranch: run.branch,
      allowedPathPrefixes: [],
      denyList: run.denyList,
      stagedDiff: safe(() => git.stagedDiff(), ""),
    });

    this.transition(runId, State.IMPLEMENTING, State.VERIFYING_STEP, "session-settled",
      JSON.stringify({ claimed: result.artifact?.status, gate: gate.passed }));

    const claimed = result.artifact?.status;

    // Map claimed status → controller action AFTER mechanical gating (Section 6).
    if (claimed === AgentStatus.NEEDS_DECISION) {
      throw new PauseSignal(`Step ${next.id} needs a human decision: ${result.artifact?.summary ?? ""}`);
    }
    if (claimed === AgentStatus.BLOCKED) {
      this.store.setStepStatus(runId, next.id, "blocked");
      this.transition(runId, State.VERIFYING_STEP, State.BLOCKED, "agent-blocked", result.artifact?.summary);
      return;
    }

    if (gate.passed && claimed === AgentStatus.DONE) {
      // Advance to checkpoint.
      this.transition(runId, State.VERIFYING_STEP, State.CHECKPOINTING, "gate-passed");
      this.checkpoint(runId, next.id, result.artifact!, git, after);
      this.store.setStepStatus(runId, next.id, "done");
      this.transition(runId, State.CHECKPOINTING, State.IMPLEMENTING, "checkpointed");
      return;
    }

    // Gate failed, or claim was FAILED → bounded retry; else fail.
    if (gate.pause) {
      throw new PauseSignal(`Step ${next.id} failed a scope/confidentiality gate: ${gate.failures.join("; ")}`);
    }
    if (attempts >= run.config.maxImplAttemptsPerStep) {
      this.store.setStepStatus(runId, next.id, "failed");
      this.stopRun(runId, State.FAILED, `Step ${next.id} exhausted ${attempts} attempts: ${gate.failures.join("; ")}`);
      return;
    }
    // Remain the active step for a bounded correction attempt.
    this.transition(runId, State.VERIFYING_STEP, State.IMPLEMENTING, "gate-failed-retry", gate.failures.join("; "));
  }

  private checkpoint(runId: string, stepId: string, artifact: TaskArtifact, git: GitLike, after: GitSnapshot): void {
    const run = this.requireRun(runId);
    let head = after.head;
    if (run.config.checkpointPolicy === "commit") {
      // Only genuine product code may be committed; gate already enforced scope.
      head = git.commitCheckpoint(`[qfb] ${stepId}: ${artifact.summary}`.slice(0, 72), artifact.changedFiles);
    }
    this.store.recordCheckpoint(runId, stepId, head, after.dirtyFingerprint);
  }

  // ------------------------------------------------- Phase C: hardening
  private async doHardening(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const git = this.makeGit(run.repoPath);
    const stage = run.state;
    const stageKey = stage === State.HARDENING_IDENTIFY ? "identify" : stage === State.HARDENING_WRITE_TESTS ? "write" : "fix";
    const pass = this.store.getNumber(runId, "hardening-pass");

    const artifactPath = this.artifactPath(runId, `hardening-${stageKey}-p${pass}.json`);
    const sessionId = `${runId}-harden-${stageKey}-p${pass}`;
    const pane = await this.herdr.ensurePane({ feature: runId, phase: stage, stepId: stageKey });
    const sessionRow = this.store.recordSession(runId, stageKey, `hardening-${stageKey}`, sessionId, pane, artifactPath);
    const result = await this.pi.launch({
      runId, stepId: stageKey, cwd: run.repoPath, sessionId, artifactPath,
      inactivityTimeoutMs: run.config.sessionInactivityTimeoutMs,
      prompt: this.buildHardeningPrompt(run.designPath, stage, artifactPath),
    });
    this.store.endSession(sessionRow, result.artifact?.status ?? "unknown");

    // Each stage must produce a verified typed handoff before the next begins.
    if (!result.artifact) {
      throw new PauseSignal(`Hardening stage ${stageKey} produced no handoff artifact.`);
    }
    if (result.artifact.status === AgentStatus.NEEDS_DECISION) {
      throw new PauseSignal(`Hardening stage ${stageKey} needs a human decision: ${result.artifact.summary}`);
    }

    if (stage === State.HARDENING_IDENTIFY) {
      this.transition(runId, stage, State.HARDENING_WRITE_TESTS, "gap-handoff-verified");
      return;
    }
    if (stage === State.HARDENING_WRITE_TESTS) {
      // Preserve exposed bugs; do not weaken tests.
      const bugs = result.artifact.bugs ?? [];
      this.store.setCounter(runId, "open-bugs", JSON.stringify(bugs));
      this.transition(runId, stage, State.HARDENING_FIX_BUGS, "tests-written");
      return;
    }

    // HARDENING_FIX_BUGS: check fix outcome + bug-identity no-progress.
    const openBugs = JSON.parse(this.store.getCounter(runId, "open-bugs") ?? "[]") as {
      id: string; location: string; repro: string;
    }[];
    const remaining = result.artifact.bugs ?? [];
    const identities = remaining.map((b) => bugIdentity(b));
    const history = JSON.parse(this.store.getCounter(runId, "bug-identity-history") ?? "[]") as string[][];
    const survivors = detectNoProgress(history, identities, run.config.maxNoProgress);
    history.push(identities);
    this.store.setCounter(runId, "bug-identity-history", JSON.stringify(history));

    if (survivors.length > 0) {
      this.stopRun(runId, State.FAILED, `Hardening bug(s) recur with unchanged identity (no progress): ${survivors.join(", ")}`);
      return;
    }

    const fixIters = this.store.getNumber(runId, "hardening-fix-iters") + 1;
    this.store.setNumber(runId, "hardening-fix-iters", fixIters);

    if (remaining.length === 0) {
      // Phase C complete → stabilization.
      this.transition(runId, stage, State.REVIEWING, "hardening-complete");
      return;
    }
    if (fixIters >= run.config.maxHardeningFixIterations) {
      this.stopRun(runId, State.FAILED, `Hardening fix budget exhausted with ${remaining.length} bug(s) still failing.`);
      return;
    }
    // Loop: another identify/write/fix pass within bounds.
    if (pass + 1 >= run.config.maxHardeningGapPasses) {
      this.transition(runId, stage, State.REVIEWING, "hardening-passes-exhausted");
      return;
    }
    this.store.setNumber(runId, "hardening-pass", pass + 1);
    this.store.setCounter(runId, "open-bugs", JSON.stringify(remaining));
    void openBugs;
    this.transition(runId, stage, State.HARDENING_IDENTIFY, "hardening-loop");
  }

  // ------------------------------------------------- Phase D: review/fix
  private async doReview(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const git = this.makeGit(run.repoPath);
    const candidate = git.snapshot(run.baseRef);
    const iteration = this.store.getReviews(runId).length + 1;

    if (iteration > run.config.maxReviewIterations) {
      // Do NOT auto-accept an incomplete review on hitting the cap (Section 8.2).
      this.stopRun(runId, State.FAILED, `Review iteration limit (${run.config.maxReviewIterations}) reached without acceptance.`);
      return;
    }

    const artifactPath = this.artifactPath(runId, `review-${iteration}.json`);
    const sessionId = `${runId}-review-${iteration}`;
    const pane = await this.herdr.ensurePane({ feature: runId, phase: "REVIEWING", stepId: "review", reviewIteration: iteration });
    const sessionRow = this.store.recordSession(runId, "review", "review", sessionId, pane, artifactPath);
    const result = await this.pi.launch({
      runId, stepId: "review", cwd: run.repoPath, sessionId, artifactPath,
      inactivityTimeoutMs: run.config.sessionInactivityTimeoutMs,
      prompt: this.buildReviewPrompt(run.baseRef, run.config.reviewLevel, artifactPath),
    });
    this.store.endSession(sessionRow, result.artifact?.status ?? "unknown");

    if (!result.artifact?.reviewReportPath || !existsSync(result.artifact.reviewReportPath)) {
      throw new PauseSignal("Review session did not preserve a raw review-pr report.");
    }
    const raw = await readFile(result.artifact.reviewReportPath, "utf8");

    let report;
    try {
      report = parseReviewReport(raw);
    } catch (e) {
      if (e instanceof AmbiguousReportError) {
        throw new PauseSignal(`Review report ambiguous — cannot extract verdict/findings: ${e.message}`);
      }
      throw e;
    }

    this.store.recordReview(runId, iteration, report.verdict, report.testGatePassed, result.artifact.reviewReportPath, candidate.dirtyFingerprint);

    // Associate findings with the exact reviewed candidate; reject stale ones.
    const liveCandidate = git.snapshot(run.baseRef);
    if (liveCandidate.dirtyFingerprint !== candidate.dirtyFingerprint) {
      throw new PauseSignal("Checkout changed during review; result is stale and cannot be accepted.");
    }

    if (report.verdict === "needs-discussion") {
      throw new PauseSignal("Review returned needs-discussion; a human decision is required.");
    }

    if (isAcceptable(report, run.config.strictReviewPolicy)) {
      this.transition(runId, State.REVIEWING, State.COMPLETED, "review-accepted");
      this.store.setStopReason(runId, null);
      return;
    }

    // No-progress detection over finding identity (Section 8.2).
    const ids = selectActionableFindings(report, run.config.strictReviewPolicy).map(findingIdentity);
    const history = JSON.parse(this.store.getCounter(runId, "finding-identity-history") ?? "[]") as string[][];
    const survivors = detectNoProgress(history, ids, run.config.maxNoProgress);
    history.push(ids);
    this.store.setCounter(runId, "finding-identity-history", JSON.stringify(history));
    if (survivors.length > 0) {
      this.stopRun(runId, State.FAILED, `Blocker(s) survive remediation without progress: ${survivors.join(", ")}`);
      return;
    }

    // Stash selected findings for the fix session, then transition.
    this.store.setCounter(runId, "pending-findings", JSON.stringify(selectActionableFindings(report, run.config.strictReviewPolicy)));
    this.transition(runId, State.REVIEWING, State.FIXING, "blocking-findings");
  }

  private async doFix(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const findings = JSON.parse(this.store.getCounter(runId, "pending-findings") ?? "[]");
    const iteration = this.store.getReviews(runId).length;
    const artifactPath = this.artifactPath(runId, `fix-${iteration}.json`);
    const sessionId = `${runId}-fix-${iteration}`;
    const pane = await this.herdr.ensurePane({ feature: runId, phase: "FIXING", stepId: "fix", reviewIteration: iteration });
    const sessionRow = this.store.recordSession(runId, "fix", "fix", sessionId, pane, artifactPath);
    const result = await this.pi.launch({
      runId, stepId: "fix", cwd: run.repoPath, sessionId, artifactPath,
      inactivityTimeoutMs: run.config.sessionInactivityTimeoutMs,
      prompt: this.buildFixPrompt(findings, artifactPath),
    });
    this.store.endSession(sessionRow, result.artifact?.status ?? "unknown");

    const outcome = result.artifact?.fixOutcome;
    if (outcome !== FixOutcome.CLEAN) {
      // Only Clean may advance the normal workflow (Section 3).
      this.stopRun(runId, State.FAILED, `fix-pr returned ${outcome ?? "unknown"}; stopping normal progression.`);
      return;
    }
    this.transition(runId, State.FIXING, State.VERIFYING_FIX, "fix-clean");
  }

  // ---------------------------------------------------------------- control ops
  pause(runId: string): void {
    const run = this.requireRun(runId);
    this.store.setStopReason(runId, "Operator requested pause.");
    if (run.state !== State.PAUSED) {
      this.transition(runId, run.state, State.PAUSED, "operator-pause");
    }
  }

  resume(runId: string): void {
    const run = this.requireRun(runId);
    this.checkDesignIntegrity(runId);
    if (run.state === State.PAUSED) {
      this.transition(runId, State.PAUSED, State.READY, "operator-resume");
      this.store.setStopReason(runId, null);
    }
  }

  stop(runId: string): void {
    const run = this.requireRun(runId);
    this.stopRun(runId, State.FAILED, "Operator stopped the run; state preserved for reconciliation.");
    void run;
  }

  status(runId: string): Record<string, unknown> {
    const run = this.requireRun(runId);
    const steps = this.store.getSteps(runId);
    return {
      runId,
      state: run.state,
      approved: run.approved,
      repoPath: run.repoPath,
      branch: run.branch,
      baseRef: run.baseRef,
      stopReason: run.stopReason,
      preparedPlanPath: this.store.getCounter(runId, "prepared-plan-path"),
      planStrategy: this.store.getCounter(runId, "plan-strategy"),
      steps: steps.map((s) => ({ id: s.id, status: s.status, attempts: s.attempts, text: s.text.split("\n")[0] })),
      stepsDone: steps.filter((s) => s.status === "done").length,
      stepsTotal: steps.length,
      sessionCount: this.store.getSessionCount(runId),
      reviews: this.store.getReviews(runId).length,
      checkpoints: this.store.getCheckpoints(runId).length,
    };
  }

  // ---------------------------------------------------------------- helpers
  private stopRun(runId: string, state: StateName, reason: string): StateName {
    const run = this.requireRun(runId);
    this.store.setStopReason(runId, reason);
    if (run.state !== state) this.transition(runId, run.state, state, "stop", reason);
    return state;
  }

  private checkDesignIntegrity(runId: string): void {
    const run = this.requireRun(runId);
    if (!existsSync(run.designPath)) return;
    const current = sha256(readFileSync(run.designPath, "utf8"));
    if (current !== run.designHash) {
      if (run.state !== State.PAUSED) {
        this.transition(runId, run.state, State.PAUSED, "design-changed");
      }
      this.store.setStopReason(runId, "Approved design changed after approval; re-approval required.");
      throw new PauseSignal("Approved design document changed; run paused pending re-approval.");
    }
  }

  private transition(runId: string, from: StateName, to: StateName, op: string, evidence?: string): void {
    assertTransition(from, to);
    this.store.setState(runId, to);
    this.store.recordTransition(runId, from, to, op, evidence);
  }

  private requireRun(runId: string) {
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

  private buildStepPrompt(designPath: string, step: { id: string; text: string }, done: string[], artifactPath: string): string {
    return [
      `You are implementing ONE step of an approved QuestDB feature plan.`,
      `First read CLAUDE.md and the approved design at: ${designPath}`,
      `Completed steps: ${done.length ? done.join(", ") : "(none)"}`,
      ``,
      `## Assigned step ${step.id}`,
      step.text,
      ``,
      `Rules:`,
      `- Implement ONLY this step and its tests. Do NOT start another step.`,
      `- Do NOT change the architecture, requirements, or other plan steps.`,
      `- Never run concurrent Maven invocations. Treat java-questdb-client/ as a separate repo.`,
      `- When done, write a typed JSON TaskArtifact to: ${artifactPath}`,
      `  with fields: {runId, stepId, kind:"implementation", status, summary, changedFiles[],`,
      `  testCommands[{command,exitCode,logPath}], limitations[], notableDecisions[], createdAt}.`,
      `- status MUST be one of DONE | BLOCKED | NEEDS_DECISION | FAILED.`,
    ].join("\n");
  }

  private buildHardeningPrompt(designPath: string, stage: StateName, artifactPath: string): string {
    const what =
      stage === State.HARDENING_IDENTIFY
        ? "Analyze the cumulative feature diff and existing tests; write a prioritized coverage-gap handoff (fuzz, concurrency, edge cases, integration, fault injection). Do NOT modify code or tests."
        : stage === State.HARDENING_WRITE_TESTS
        ? "Implement the tests from the coverage-gap handoff. If a test exposes a real bug, record it in the bug handoff (stable id, repro, failing test, observed vs expected) — do NOT weaken or delete the test."
        : "Fix each confirmed bug (the defect, not the test). Validate the previously failing test now passes without regressions.";
    return [
      `Phase C test-coverage hardening stage: ${stage}.`,
      `Read CLAUDE.md and the approved design at: ${designPath}`,
      what,
      `Write a typed JSON TaskArtifact to ${artifactPath} (include a bugs[] array for write/fix stages).`,
    ].join("\n");
  }

  private buildReviewPrompt(base: string, level: number, artifactPath: string): string {
    return [
      `Run QuestDB's review-pr skill on the cumulative feature diff.`,
      `Invoke: /skill:review-pr --range=${base}.. --level=${level}`,
      `Preserve the COMPLETE raw report to a file and set reviewReportPath to it.`,
      `The report MUST contain a machine-readable fenced \`\`\`qfb-review JSON block with`,
      `{verdict, testGatePassed, findings:[{id,severity,location,evidence}]}.`,
      `Write a typed JSON TaskArtifact (kind:"review") to ${artifactPath}.`,
    ].join("\n");
  }

  private buildFixPrompt(findings: unknown, artifactPath: string): string {
    return [
      `Run QuestDB's fix-pr skill against these authorized findings:`,
      JSON.stringify(findings, null, 2),
      `Preserve finding IDs, severities, context, and evidence. Do not stage/commit/push.`,
      `Report the skill's distinct outcome in fixOutcome: Clean | Blocked | Diverging | Exhausted.`,
      `Write a typed JSON TaskArtifact (kind:"fix") to ${artifactPath}.`,
    ].join("\n");
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export async function writeArtifactFile(path: string, artifact: TaskArtifact): Promise<void> {
  await writeFile(path, JSON.stringify(artifact, null, 2));
}
