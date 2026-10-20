import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeHarness, artifact, THREE_STEP_DESIGN } from "./helpers.ts";
import type { Harness, PiHandler } from "./helpers.ts";
import type { PiLaunchRequest } from "../src/adapters/pi.ts";

/** Impl handler: mutates git to simulate a code change and claims DONE. */
function implDone(stepId: string): PiHandler {
  return (_req, git) => {
    git.state.fingerprint = "fp-" + stepId + "-" + Math.random().toString(16).slice(2, 6);
    return { artifact: artifact({ stepId, kind: "implementation", status: "DONE", changedFiles: ["src/" + stepId + ".java"] }) };
  };
}

/** Read-only coverage-gap identification. */
function identify(): PiHandler {
  return () => ({ artifact: artifact({ kind: "coverage-gap", status: "DONE", testCommands: [] }) });
}

/**
 * Hardening write/fix stage: `bugs` are the exposed (write) or still-open (fix)
 * bugs. Their tests really fail while open, and the session claims exactly that.
 */
function hardening(bugs: { failingTest: string }[] = [], extra: Record<string, unknown> = {}): PiHandler {
  return (_req, git) => {
    git.state.fingerprint = "fp-h-" + Math.random().toString(16).slice(2, 6);
    git.state.failing = bugs.map((b) => b.failingTest);
    const testCommands = [
      { command: "mvn -q test -pl core", exitCode: 0 },
      ...bugs.map((b) => ({ command: `mvn -Dtest=${b.failingTest} test`, exitCode: 1 })),
    ];
    return { artifact: artifact({ kind: "bug", status: "DONE", bugs: bugs as never, testCommands, ...extra }) };
  };
}

function writeReport(req: PiLaunchRequest, report: unknown): string {
  const p = join(dirname(req.artifactPath), req.sessionId + "-raw.md");
  writeFileSync(p, "Review report\n```qfb-review\n" + JSON.stringify(report) + "\n```\n");
  return p;
}

function review(report: unknown, mutateGit = false): PiHandler {
  return (req, git) => {
    const reportPath = writeReport(req, report);
    if (mutateGit) git.state.fingerprint = "changed-during-review";
    return { artifact: artifact({ kind: "review", status: "DONE", testCommands: [], reviewReportPath: reportPath }) };
  };
}

function fix(outcome: string): PiHandler {
  return (_req, git) => {
    git.state.fingerprint = "fp-fix-" + Math.random().toString(16).slice(2, 6);
    return { artifact: artifact({ kind: "fix", status: "DONE", fixOutcome: outcome as never }) };
  };
}

const HAPPY_HARDENING = [identify(), hardening([])];
const APPROVED = { verdict: "approved", testGatePassed: true, findings: [] };
const BUG = { id: "B1", location: "X.java:1", repro: "r", failingTest: "T", observed: "o", expected: "e" };
const happyTail = () => [implDone("S2"), implDone("S3"), ...HAPPY_HARDENING, review(APPROVED)];

function start(h: Harness, config: Record<string, unknown> = {}, denyList: string[] = []): string {
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config, denyList });
  h.controller.approve(runId);
  return runId;
}

const ops = (h: Harness, runId: string) => h.store.getTransitions(runId).map((t) => t.operation as string);

test("three-step plan completes using three separate fresh Pi sessions", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    ...HAPPY_HARDENING,
    review(APPROVED),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "base~0" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);

  assert.equal(state, "COMPLETED");
  const implLaunches = h.pi.launches.filter((l) => /^run-.*-S\d-/.test(l.sessionId));
  assert.equal(implLaunches.length, 3);
  // Fresh session per step: all session ids distinct.
  assert.equal(new Set(implLaunches.map((l) => l.sessionId)).size, 3);
  // Serial order preserved.
  assert.deepEqual(implLaunches.map((l) => l.stepId), ["S1", "S2", "S3"]);
  const st = h.controller.status(runId);
  assert.equal(st.stepsDone, 3);
});

test("the next step cannot begin before the previous one passes verification", async () => {
  // S1's tests really fail once, then succeed; S2 must not launch until S1 is done.
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.fingerprint = "fpS1a"; return { artifact: artifact({ stepId: "S1", testCommands: [{ command: "mvn test", exitCode: 1 }] }) }; },
    implDone("S1"),
    ...happyTail(),
  ]);
  h.tests.exitFor = (c) => (c === "mvn test" ? 1 : 0);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  const order = h.pi.launches.filter((l) => /-S\d-/.test(l.sessionId)).map((l) => l.stepId);
  // S1 appears twice (retry) before S2 ever starts.
  assert.deepEqual(order.slice(0, 3), ["S1", "S1", "S2"]);
});

test("a failed test prevents step completion and exhausts attempts -> FAILED", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.fingerprint = "x"; return { artifact: artifact({ stepId: "S1", testCommands: [{ command: "mvn test", exitCode: 1 }] }) }; },
  ]);
  h.tests.exitFor = () => 1;
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.notEqual(h.store.getSteps(runId)[0]!.status, "done");
});

test("mechanical gating rejects a DONE claim with no artifact", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [() => ({ artifact: null, settled: true })]);
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
});

test("a claimed passing test that really fails is rejected (exit codes come from the controller's re-run)", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  h.tests.exitFor = () => 1; // the agent claims exit 0
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /claims .* exited 0, but the controller's re-run exited 1/);
  assert.deepEqual(h.tests.ran, ["mvn -q test -pl core"]);
});

test("a malformed artifact is a gate failure, not a controller crash", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [() => ({ artifact: { status: "DONE", summary: "x", testCommands: "nope" } as never })]);
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /No valid typed task handoff artifact/);
});

test("an agent moving HEAD (commit/reset/rebase) pauses the run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.head = "rewritten"; git.state.fingerprint = "z"; return { artifact: artifact({ stepId: "S1" }) }; },
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /HEAD moved/);
  assert.notEqual(h.store.getSteps(runId)[0]!.status, "done");
});

test("NEEDS_DECISION pauses the run for a human decision", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    () => ({ artifact: artifact({ stepId: "S1", status: "NEEDS_DECISION", summary: "architectural fork" }) }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /human decision/);
});

test("edited design document invalidates approval until reconciled", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  const runId = start(h);
  writeFileSync(h.designPath, THREE_STEP_DESIGN + "\n4. Sneaky extra step.\n");
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /re-approval/);
  await assert.rejects(() => h.controller.resume(runId), /re-approval required/);
  // Re-approve and the run can proceed again.
  h.controller.approve(runId);
  assert.equal(h.controller.status(runId).state, "READY");
});

test("blocking review triggers fix-pr then a fresh review that completes", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "npe-v1" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(blocking), fix("Clean"), review(APPROVED),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.controller.status(runId).reviews, 2);
  assert.ok(h.pi.launches.some((l) => l.sessionId.includes("-fix-")));
});

test("needs-discussion verdict pauses the run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review({ verdict: "needs-discussion", testGatePassed: true, findings: [] }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
});

for (const outcome of ["Blocked", "Diverging", "Exhausted"]) {
  test(`fix-pr ${outcome} stops normal progression`, async () => {
    const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "x" }] };
    const h = makeHarness(THREE_STEP_DESIGN, [
      implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
      review(blocking), fix(outcome),
    ]);
    const runId = start(h);
    assert.equal(await h.controller.run(runId), "failed");
    assert.match(String(h.controller.status(runId).stopReason), new RegExp(outcome));
  });
}

test("stale review result is rejected after the checkout changes", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(APPROVED, /* mutateGit */ true),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /stale/i);
});

test("review/fix loop respects configured iteration limit", async () => {
  // Always blocking with CHANGING finding identity so no-progress never trips.
  const h = makeHarness(THREE_STEP_DESIGN, []);
  let n = 0;
  const blockingN = (): PiHandler => (req) => {
    const reportPath = writeReport(req, { verdict: "blocking", testGatePassed: true, findings: [{ id: "F" + n, severity: "critical", location: "A:" + n, evidence: "e" + n++ }] });
    return { artifact: artifact({ kind: "review", status: "DONE", testCommands: [], reviewReportPath: reportPath }) };
  };
  h.pi.push(implDone("S1")); h.pi.push(implDone("S2")); h.pi.push(implDone("S3"));
  for (const x of HAPPY_HARDENING) h.pi.push(x);
  for (let i = 0; i < 10; i++) { h.pi.push(blockingN()); h.pi.push(fix("Clean")); }
  const runId = start(h, { maxReviewIterations: 2 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /iteration limit/i);
});

test("recurring blocker with unchanged finding identity is detected as no-progress", async () => {
  const same = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "same-evidence" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(same), fix("Clean"), review(same), fix("Clean"), review(same),
  ]);
  const runId = start(h, { maxReviewIterations: 10, maxNoProgress: 2 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /without progress/i);
});

test("hard ceiling on total Pi sessions is enforced", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1"), implDone("S2"), implDone("S3")]);
  const runId = start(h, { maxTotalSessions: 2 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /ceiling/i);
});

test("two controller instances cannot run concurrently against the same run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  const runId = start(h);
  assert.equal(h.store.acquireLock(runId), true); // simulate another instance holding the lock
  await assert.rejects(() => h.controller.run(runId), /locked by another controller/);
  h.store.releaseLock(runId);
});

test("two runs cannot drive the same checkout concurrently", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  const a = start(h);
  const { runId: b } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "other-base" });
  h.controller.approve(b);
  assert.equal(h.store.acquireLock([a, "repo:/repo"]), true); // run A's controller is live
  await assert.rejects(() => h.controller.run(b), /in use by another QFB run/);
  h.store.releaseLock([a, "repo:/repo"]);
});

test("build-style run is interruptible and resumes without duplicating completed work", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"),
    () => ({ artifact: artifact({ stepId: "S2", status: "NEEDS_DECISION", summary: "needs a call" }) }),
  ]);
  const runId = start(h);

  // First invocation stops at the decision point.
  assert.equal(await h.controller.run(runId), "paused");
  assert.equal(h.controller.status(runId).stepsDone, 1);
  assert.equal(h.pi.launches.filter((l) => /-S1-/.test(l.sessionId)).length, 1);

  // Operator addresses it; queue the rest of the happy path and resume.
  h.pi.push(implDone("S2")); h.pi.push(implDone("S3"));
  for (const x of HAPPY_HARDENING) h.pi.push(x);
  h.pi.push(review(APPROVED));
  assert.equal(await h.controller.resume(runId), "IMPLEMENTING");

  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.controller.status(runId).stepsDone, 3);
  // S1 was never re-launched during the resumed run.
  assert.equal(h.pi.launches.filter((l) => /-S1-/.test(l.sessionId)).length, 1);
});

test("statusDetails reports the current session and recent transitions", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING, review(APPROVED),
  ]);
  const runId = start(h);
  await h.controller.run(runId);

  const d = h.controller.statusDetails(runId);
  assert.ok(d.currentSession, "expected a current session");
  assert.equal(d.currentSession!.kind, "review");
  assert.match(d.currentSession!.transcriptPath ?? "", /\.transcript\.log$/);
  const tos = d.recentTransitions.map((t) => t.to);
  assert.ok(tos.includes("COMPLETED"));
  assert.ok(d.recentTransitions.every((t) => typeof t.at === "string" && t.at.length > 0));
});

test("crash in an intermediate step state (VERIFYING_STEP) is resumable, not wedged", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const runId = start(h);
  // Simulate a store written by an older version that persisted a transient state.
  h.store.setState(runId, "VERIFYING_STEP" as never);
  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.controller.status(runId).stepsDone, 3);
});

test("confidentiality is gated on the git-derived diff, not the agent's self-report", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_req, git) => {
      git.state.fingerprint = "leaky";
      git.state.changedFiles = ["src/Orders.java"];
      git.state.diffText = "+ // migrate AcmeCorp orders\n";
      return { artifact: artifact({ stepId: "S1", status: "DONE", changedFiles: ["src/Orders.java"] }) };
    },
  ]);
  const runId = start(h, {}, ["AcmeCorp"]);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /confidentiality/i);
});

test("a BLOCKED step can be unblocked by the operator and resumed to completion", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => {
      git.state.fingerprint = "s1-blocked";
      return { artifact: artifact({ stepId: "S1", status: "BLOCKED", summary: "waiting on upstream dep" }) };
    },
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "blocked");
  assert.equal(h.store.getSteps(runId)[0]!.status, "blocked");

  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);
  await h.controller.resume(runId);
  assert.equal(h.store.getSteps(runId)[0]!.status, "pending");
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.controller.status(runId).stepsDone, 3);
});

test("review that is unacceptable with no actionable findings pauses for a human", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review({ verdict: "approved", testGatePassed: false, findings: [] }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /human decision/i);
});

test("findRun locates an existing run for the same repo/design/base (resumption key)", () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "base-ref" });
  assert.equal(h.store.findRun("/repo", h.designPath, "base-ref")?.id, runId);
  assert.equal(h.store.findRun("/repo", h.designPath, "other-base"), null);
});

// ------------------------------------------------------------------ pause / stop

test("a pause requested by another process during a session is honored after that session, not lost", async () => {
  let runId = "";
  const h = makeHarness(THREE_STEP_DESIGN, []);
  h.pi.push((req, git) => {
    assert.equal(h.other().pause(runId), "requested"); // `qfb pause` from a second terminal
    return implDone("S1")(req, git);
  });
  runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.equal(h.store.getSteps(runId)[0]!.status, "done"); // the active write finished
  assert.equal(h.pi.launches.length, 1); // ...and nothing new started
  for (const x of happyTail()) h.pi.push(x);
  await h.controller.resume(runId);
  assert.equal(await h.controller.run(runId), "COMPLETED");
});

test("a stop from another process kills the active session and requires reconciliation", async () => {
  let runId = "";
  const h = makeHarness(THREE_STEP_DESIGN, []);
  h.pi.push((req, git) => {
    git.state.fingerprint = "partial";
    void h.other().stop(runId); // `qfb stop` from a second terminal
    return { settled: false, exitCode: null, artifact: null };
  });
  runId = start(h);
  assert.equal(await h.controller.run(runId), "reconciliation");
  assert.equal(h.pi.terminated.length, 1);
  const st = h.controller.status(runId);
  assert.match(String(st.stopReason), /forced stop.*preserved at .*interrupted\.patch/);
  assert.equal(st.resumeTo, "IMPLEMENTING");
  assert.ok(existsSync(String(st.stopReason).match(/at (\S+\.patch)/)![1]!));
  // Not resumed blindly by a re-run; the operator reconciles and resumes.
  assert.equal(await h.controller.run(runId), "reconciliation");
  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);
  await h.controller.resume(runId);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.match(h.pi.launches[1]!.prompt, /partial changes from an earlier/);
});

test("state changes are compare-and-set: a concurrent change is refused, never overwritten", async () => {
  let runId = "";
  const h = makeHarness(THREE_STEP_DESIGN, []);
  h.pi.push((req, git) => {
    h.store.setState(runId, "paused" as never); // some other actor bypassing the request API
    return implDone("S1")(req, git);
  });
  runId = start(h);
  await assert.rejects(() => h.controller.run(runId), /State conflict/);
  assert.equal(h.controller.status(runId).state, "paused");
});

// ------------------------------------------------------------------ resume semantics

test("resume after an ambiguous review launches a fresh review (no replay, no hardening re-run)", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    (req) => {
      const p = join(dirname(req.artifactPath), "bad.md");
      writeFileSync(p, "prose only");
      return { artifact: artifact({ kind: "review", testCommands: [], reviewReportPath: p }) };
    },
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /ambiguous/);
  const before = h.pi.launches.length;
  h.pi.push(review(APPROVED));
  assert.equal(await h.controller.resume(runId), "REVIEWING");
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.deepEqual(h.pi.launches.slice(before).map((l) => l.stepId), ["review"]);
});

test("resume after a needs-discussion review goes straight back to review", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    identify(), hardening([BUG]), hardening([]), // pass 0 exposes and fixes B1
    identify(), hardening([]),                   // pass 1 finds nothing
    review({ verdict: "needs-discussion", testGatePassed: true, findings: [] }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  const before = h.pi.launches.length;
  h.pi.push(review(APPROVED));
  await h.controller.resume(runId);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.deepEqual(h.pi.launches.slice(before).map((l) => l.stepId), ["review"]);
});

test("resume after a hardening NEEDS_DECISION re-runs that stage with a fresh session", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    identify(), hardening([], { status: "NEEDS_DECISION", summary: "which fault model?" }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  h.pi.push(hardening([])); h.pi.push(review(APPROVED));
  assert.equal(await h.controller.resume(runId), "HARDENING_WRITE_TESTS");
  assert.equal(await h.controller.run(runId), "COMPLETED");
  const writes = h.pi.launches.filter((l) => l.stepId === "write-p0").map((l) => l.sessionId);
  assert.equal(new Set(writes).size, 2); // a new session id, not a replay
});

test("a FAILED run is resumable as an audited operator retry with a fresh budget window", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [() => ({ artifact: null })]);
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.equal(h.store.getSteps(runId)[0]!.status, "failed");
  // Restarting alone grants nothing.
  assert.equal(await h.controller.run(runId), "failed");
  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);
  assert.equal(await h.controller.resume(runId), "IMPLEMENTING");
  assert.ok(ops(h, runId).includes("operator-retry"));
  assert.equal(await h.controller.run(runId), "COMPLETED");
});

test("re-approving a FAILED run's edited design retries the failed step instead of skipping it", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1"), implDone("S2"), () => ({ artifact: null })]);
  const runId = start(h, { maxImplAttemptsPerStep: 1 });
  assert.equal(await h.controller.run(runId), "failed");
  writeFileSync(h.designPath, THREE_STEP_DESIGN + "\n<!-- clarified S3 -->\n");
  await assert.rejects(() => h.controller.resume(runId), /re-approval/);
  h.controller.approve(runId);
  h.pi.push(implDone("S3"));
  for (const x of HAPPY_HARDENING) h.pi.push(x);
  h.pi.push(review(APPROVED));
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.pi.launches.filter((l) => l.stepId === "S3").length, 2);
});

// ------------------------------------------------------------------ crash recovery

test("restart with a still-running session from a crashed controller enters reconciliation, never a 2nd writer", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const runId = start(h);
  // The previous controller died mid-session; its Pi process is still alive.
  h.store.setState(runId, "IMPLEMENTING" as never);
  h.store.setStepStatus(runId, "S1", "active");
  h.store.incStepAttempts(runId, "S1");
  const row = h.store.recordSession(runId, "S1", "implementation", `${runId}-S1-a1`, null, join(h.dir, "a1.json"), h.git.snapshot("b"));
  h.store.setSessionPid(row, 4242, "host");
  h.pi.orphans.add(`${runId}-S1-a1`);

  assert.equal(await h.controller.run(runId), "reconciliation");
  assert.equal(h.pi.launches.length, 0);
  assert.match(String(h.controller.status(runId).stopReason), /still running; refusing to start a second writer/);
  await assert.rejects(() => h.controller.resume(runId), /still running/);

  // Once it is gone, the operator resumes: evidence is kept, and the next attempt is informed.
  h.pi.orphans.clear();
  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);
  await h.controller.resume(runId);
  assert.ok(existsSync(join(h.dir, "a1.json.interrupted.patch")));
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.pi.launches[0]!.sessionId, `${runId}-S1-a2`);
  assert.match(h.pi.launches[0]!.prompt, /attempt 2.*partial changes/s);
});

test("restart after a crash whose session is provably gone auto-reconciles with preserved evidence", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const runId = start(h);
  h.store.setState(runId, "IMPLEMENTING" as never);
  h.store.setStepStatus(runId, "S1", "active");
  h.store.incStepAttempts(runId, "S1");
  h.store.recordSession(runId, "S1", "implementation", `${runId}-S1-a1`, null, join(h.dir, "a1.json"), h.git.snapshot("b"));
  h.pi.push(implDone("S1"));
  for (const x of happyTail()) h.pi.push(x);

  assert.equal(await h.controller.run(runId), "COMPLETED");
  const o = ops(h, runId);
  assert.ok(o.indexOf("interrupted-session") >= 0 && o.indexOf("auto-reconciled") > o.indexOf("interrupted-session"));
  assert.ok(existsSync(join(h.dir, "a1.json.interrupted.patch")));
  assert.equal(h.pi.launches[0]!.sessionId, `${runId}-S1-a2`);
});

test("a crash after a session ended but before its outcome was recorded re-processes it without relaunching", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const runId = start(h);
  h.store.setState(runId, "IMPLEMENTING" as never);
  h.store.setStepStatus(runId, "S1", "active");
  h.store.incStepAttempts(runId, "S1");
  const path = join(h.dir, "artifacts", runId, "S1-attempt1.json");
  const before = h.git.snapshot("b");
  const row = h.store.recordSession(runId, "S1", "implementation", `${runId}-S1-a1`, null, path, before);
  h.git.state.fingerprint = "s1-done";
  writeFileSync(path, JSON.stringify(artifact({ stepId: "S1" })));
  h.store.endSession(row, "DONE", 0, false); // ...then the controller died
  for (const x of happyTail()) h.pi.push(x);

  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.pi.launches.filter((l) => l.stepId === "S1").length, 0);
  assert.equal(h.store.getSteps(runId)[0]!.status, "done");
});

// ------------------------------------------------------------------ Phase C gating

test("open hardening bugs never reach review: fix budget exhausted -> FAILED", async () => {
  const bug = (i: number) => ({ ...BUG, id: "B" + i, location: "X.java:" + i });
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    identify(), hardening([bug(0)]),
    hardening([bug(1)]), hardening([bug(2)]), hardening([bug(3)]), // different ids: no-progress never trips
    review(APPROVED),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /fix budget exhausted with 1 bug/);
  assert.equal(h.pi.launches.filter((l) => l.stepId === "review").length, 0);
});

test("a hardening bug whose identity survives a fix attempt is no-progress", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    identify(), hardening([BUG]), hardening([BUG]), hardening([BUG]),
  ]);
  const runId = start(h, { maxHardeningFixIterations: 5 });
  assert.equal(await h.controller.run(runId), "failed");
  assert.match(String(h.controller.status(runId).stopReason), /no progress/);
});

test("hardening: exposed bug is fixed, a second pass runs, then review", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    identify(), hardening([BUG]), hardening([]), identify(), hardening([]),
    review(APPROVED),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.deepEqual(
    h.pi.launches.filter((l) => /-harden-/.test(l.sessionId)).map((l) => l.stepId),
    ["identify-p0", "write-p0", "fix-p0", "identify-p1", "write-p1"],
  );
  assert.match(h.pi.launches.find((l) => l.stepId === "fix-p0")!.prompt, /"B1"/); // the bug list is handed over
});

test("hardening write stage is mechanically gated (deny-listed leak pauses)", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), identify(),
    (_r, git) => {
      git.state.fingerprint = "fuzz";
      git.state.diffText = "+ // fuzz the AcmeCorp ingest scenario";
      return { artifact: artifact({ kind: "bug", bugs: [] }) };
    },
  ]);
  const runId = start(h, {}, ["AcmeCorp"]);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /Hardening write stage .*Confidentiality/);
});

test("hardening identify is read-only: modifying the checkout pauses", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    (_r, git) => { git.state.fingerprint = "touched"; return { artifact: artifact({ kind: "coverage-gap", testCommands: [] }) }; },
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /Read-only session modified the checkout/);
});

test("hardening stage claiming FAILED is retried within budget, not advanced", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), identify(),
    hardening([], { status: "FAILED", summary: "could not build" }), hardening([]),
    review(APPROVED),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.equal(h.pi.launches.filter((l) => l.stepId === "write-p0").length, 2);
  assert.ok(ops(h, runId).includes("hardening-retry"));
});

// ------------------------------------------------------------------ Phase D gating

test("fix-pr output is mechanically gated: a leak introduced by the fix pauses", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "x" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING, review(blocking),
    (_r, git) => { git.state.diffText = "+ // AcmeCorp"; git.state.fingerprint = "fixed"; return { artifact: artifact({ kind: "fix", fixOutcome: "Clean" }) }; },
  ]);
  const runId = start(h, {}, ["AcmeCorp"]);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /fix-pr claimed Clean but mechanical verification failed/);
});

test("fix-pr Clean whose tests really fail stops instead of re-reviewing", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "x" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING, review(blocking),
    (_r, git) => {
      git.state.fingerprint = "fixed";
      return { artifact: artifact({ kind: "fix", fixOutcome: "Clean", testCommands: [{ command: "mvn -Dtest=FixTest test", exitCode: 0 }] }) };
    },
  ]);
  h.tests.exitFor = (c) => (c.includes("FixTest") ? 1 : 0);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "failed");
  assert.equal(h.controller.status(runId).resumeTo, "REVIEWING");
});

test("completion requires the accumulated regression suite to pass on the reviewed candidate", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING, review(APPROVED),
  ]);
  const runId = start(h);
  let n = 0;
  // Each step's tests pass when verified; the final re-run on the candidate fails.
  h.tests.exitFor = () => (++n > 4 ? 1 : 0);
  assert.equal(await h.controller.run(runId), "paused");
  assert.match(String(h.controller.status(runId).stopReason), /Final regression run failed/);
  assert.equal(h.controller.acceptedCandidate(runId), null);
});

test("commit policy checkpoints every verified writer stage (incl. hardening and fix-pr) and keeps deny-listed text out of messages", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "x" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.fingerprint = "s1"; return { artifact: artifact({ stepId: "S1", summary: "Port the AcmeCorp ingest path" }) }; },
    implDone("S2"), implDone("S3"),
    identify(), hardening([BUG]), hardening([]), identify(), hardening([]),
    review(blocking), fix("Clean"), review(APPROVED),
  ]);
  const runId = start(h, { checkpointPolicy: "commit" }, ["AcmeCorp"]);
  assert.equal(await h.controller.run(runId), "COMPLETED");
  assert.deepEqual(h.git.commits.map((m) => m.split(":")[0]!.replace(/ checkpoint$/, "")), [
    "[qfb] S1", "[qfb] S2", "[qfb] S3",
    "[qfb] hardening-write-p0", "[qfb] hardening-fix-p0", "[qfb] hardening-write-p1", "[qfb] fix-1",
  ]);
  assert.equal(h.git.commits[0], "[qfb] S1 checkpoint");
  assert.deepEqual(h.controller.acceptedCandidate(runId), { branch: "feature/x", head: h.git.state.head, fingerprint: h.git.state.fingerprint });
});

test("commit policy refuses a dirty checkout at init", () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  h.git.state.fingerprint = "dirty";
  assert.throws(
    () => h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { checkpointPolicy: "commit" } }),
    /requires a clean checkout/,
  );
});
