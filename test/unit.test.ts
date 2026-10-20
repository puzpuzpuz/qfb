import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitError } from "../src/git.ts";
import { extractPlan } from "../src/plan.ts";
import { parseReviewReport, selectActionableFindings, isAcceptable, AmbiguousReportError } from "../src/report.ts";
import { detectNoProgress, findingIdentity } from "../src/identity.ts";
import { scanForDenyTerms } from "../src/confidentiality.ts";
import { canTransition, assertTransition, resumeTarget } from "../src/stateMachine.ts";
import { checkArtifact, confidentialityFailures, mechanicalGate, validateArtifact } from "../src/gating.ts";
import type { GateInput } from "../src/gating.ts";
import { DEFAULT_CONFIG, State, validateConfig } from "../src/types.ts";
import type { AddedContent, GitSnapshot, TaskArtifact, UnscannableFile, VerifiedTest } from "../src/types.ts";

const snap = (over: Partial<GitSnapshot> = {}): GitSnapshot => ({
  branch: "feature/x",
  head: "h1",
  dirtyFingerprint: "fp",
  submoduleHead: "sub0",
  untrackedFiles: [],
  ...over,
});

const art = (over: Partial<TaskArtifact> = {}): TaskArtifact => ({
  runId: "r",
  stepId: "S1",
  kind: "implementation",
  status: "DONE",
  summary: "ok",
  changedFiles: ["src/Foo.java"],
  testCommands: [{ command: "mvn test", exitCode: 0, logPath: "/tmp/l" }],
  limitations: [],
  notableDecisions: [],
  createdAt: "now",
  ...over,
});

test("plan: extracts ordered numbered steps under Implementation Plan", () => {
  const { steps, ambiguous } = extractPlan(THREE);
  assert.equal(ambiguous, false);
  assert.deepEqual(steps.map((s) => s.id), ["S1", "S2", "S3"]);
  assert.match(steps[0]!.text, /column reader/);
});

test("plan: ambiguous when no steps found", () => {
  const { ambiguous } = extractPlan("# Title\n\nNo plan here, just prose.");
  assert.equal(ambiguous, true);
});

test("plan: extracts heading-delimited '### Step N' steps and preserves wording", () => {
  const doc = `# Handoff

## Implementation plan

Some preamble prose that is not a step.

### Step 0 — baseline (no code)
- Read the templates.
- Confirm the repro.

### Step 1 — add ROWS codec
- Mirror avg's ROWS methods.
- Gate: lv package green.

### Commit granularity
Not a step; must be ignored.
`;
  const { steps, ambiguous, strategy } = extractPlan(doc);
  assert.equal(ambiguous, false);
  assert.equal(strategy, "heading");
  assert.deepEqual(steps.map((s) => s.id), ["S1", "S2"]);
  assert.match(steps[0]!.text, /Step 0 \u2014 baseline/);
  assert.match(steps[0]!.text, /Read the templates/);
  assert.match(steps[1]!.text, /add ROWS codec/);
  // The trailing non-step heading is not captured as a step.
  assert.ok(!steps.some((s) => /Commit granularity/.test(s.text)));
});

test("plan: normalized manifest lists each step under its stable id", () => {
  const doc = "## Implementation plan\n\n### Step 1 — do a thing\n- detail\n";
  const { normalizedMarkdown } = extractPlan(doc);
  assert.match(normalizedMarkdown, /# QFB Prepared Plan/);
  assert.match(normalizedMarkdown, /## S1/);
  assert.match(normalizedMarkdown, /do a thing/);
});

test("report: parses structured block and selects findings by policy", () => {
  const raw = "intro\n```qfb-review\n" +
    JSON.stringify({ verdict: "blocking", testGatePassed: true, findings: [
      { id: "F1", severity: "critical", location: "A.java:1", evidence: "npe" },
      { id: "F2", severity: "moderate", location: "B.java:2", evidence: "x" },
      { id: "F3", severity: "adjacent", location: "C.java", evidence: "y" },
    ] }) + "\n```\n";
  const rep = parseReviewReport(raw);
  assert.equal(rep.verdict, "blocking");
  assert.equal(selectActionableFindings(rep, false).map((f) => f.id).join(","), "F1");
  assert.equal(selectActionableFindings(rep, true).map((f) => f.id).join(","), "F1,F2");
  assert.equal(isAcceptable(rep, false), false);
});

test("report: approved + passing gate + no critical is acceptable", () => {
  const raw = "```qfb-review\n" + JSON.stringify({ verdict: "approved", testGatePassed: true, findings: [] }) + "\n```";
  assert.equal(isAcceptable(parseReviewReport(raw), false), true);
});

test("report: ambiguous surface pauses (throws)", () => {
  assert.throws(() => parseReviewReport("just prose, no block"), AmbiguousReportError);
  assert.throws(() => parseReviewReport("```qfb-review\nnot json\n```"), AmbiguousReportError);
});

test("identity: no-progress when same finding survives limit attempts", () => {
  const id = findingIdentity({ id: "F1", location: "A:1", evidence: "same" });
  assert.deepEqual(detectNoProgress([], [id], 2), []);
  assert.deepEqual(detectNoProgress([[id]], [id], 2), [id]);
  assert.deepEqual(detectNoProgress([[id]], ["other"], 2), []);
});

test("confidentiality: matches token variants case-insensitively", () => {
  assert.ok(scanForDenyTerms("the AcmeCorp table", ["Acme Corp"]).length > 0);
  assert.ok(scanForDenyTerms("select from customer_orders", ["customer orders"]).length > 0);
  assert.equal(scanForDenyTerms("nothing sensitive", ["Acme Corp"]).length, 0);
});

test("git: dirty fingerprint reflects untracked file CONTENT, not just names", () => {
  const dir = mkdtempSync(join(tmpdir(), "qfb-git-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  const base = g(["rev-parse", "HEAD"]).trim();
  const git = new Git(dir);

  // New untracked file -> fingerprint changes.
  writeFileSync(join(dir, "new.txt"), "v1\n");
  const fp1 = git.snapshot(base).dirtyFingerprint;
  // Same filename set, different CONTENT -> fingerprint must still change.
  writeFileSync(join(dir, "new.txt"), "v2-different\n");
  const fp2 = git.snapshot(base).dirtyFingerprint;
  assert.notEqual(fp1, fp2);
});

test("stateMachine: rejects invalid transitions, allows orthogonal entry and explicit recovery", () => {
  assert.equal(canTransition(State.CREATED, State.COMPLETED), false);
  assert.equal(canTransition(State.IMPLEMENTING, State.PAUSED), true);
  assert.equal(canTransition(State.COMPLETED, State.PAUSED), false);
  assert.throws(() => assertTransition(State.READY, State.COMPLETED));
  // FAILED is recoverable by an explicit operator retry, back to the interrupted phase.
  assert.equal(canTransition(State.FAILED, State.HARDENING_FIX_BUGS), true);
  assert.equal(canTransition(State.PAUSED, State.REVIEWING), true);
  assert.equal(canTransition(State.PAUSED, State.PAUSED), false);
  // Hardening stages retry by looping on themselves; others do not.
  assert.equal(canTransition(State.HARDENING_FIX_BUGS, State.HARDENING_FIX_BUGS), true);
  assert.equal(canTransition(State.REVIEWING, State.REVIEWING), false);
  assert.equal(resumeTarget(State.VERIFYING_STEP), State.IMPLEMENTING);
  assert.equal(resumeTarget(State.FIXING), State.REVIEWING);
  assert.equal(resumeTarget(State.HARDENING_WRITE_TESTS), State.HARDENING_WRITE_TESTS);
});

const ok = (command = "mvn test", code = 0): VerifiedTest => ({ command, claimedExitCode: code, exitCode: code, logPath: "/l" });
const gate = (over: Partial<GateInput> = {}) =>
  mechanicalGate({
    mode: "writer", artifact: art(), sessionCompleted: true, before: snap(), after: snap(),
    expectedBranch: "feature/x", allowedPathPrefixes: [], denyList: [],
    changedFiles: ["src/Foo.java"], added: addedIn("src/Foo.java", ""), verifiedTests: [ok()], ...over,
  });
const addedIn = (path: string, added: string, unscannable: UnscannableFile[] = []): AddedContent => ({
  files: [{ path, added }],
  unscannable,
});

test("gating: passes clean DONE step", () => {
  assert.equal(gate().passed, true);
});

test("gating: fails on missing artifact, failed test, and dirty scope", () => {
  assert.equal(gate({ artifact: null, verifiedTests: [] }).passed, false);
  assert.equal(gate({ artifact: art({ testCommands: [{ command: "mvn test", exitCode: 1 }] }), verifiedTests: [ok("mvn test", 1)] }).passed, false);

  // Scope is enforced from the GIT-DERIVED changeset, not the agent's report:
  // the forbidden handoff file is present in git even though the artifact omits it.
  const scope = gate({ changedFiles: ["src/Foo.java", "handoff.md"] });
  assert.equal(scope.passed, false);
  assert.equal(scope.pause, true);
});

test("gating: the controller's real exit code wins over the claim", () => {
  const lie = gate({ verifiedTests: [{ command: "mvn test", claimedExitCode: 0, exitCode: 1, logPath: "/l" }] });
  assert.equal(lie.passed, false);
  assert.match(lie.failures.join(), /claims "mvn test" exited 0, but the controller's re-run exited 1/);
  // Every claimed command must have been re-run.
  assert.equal(gate({ verifiedTests: [] }).passed, false);
});

test("gating: failing tests are accepted only when the bugs they expose are recorded", () => {
  const exposing = art({ testCommands: [{ command: "mvn test", exitCode: 1 }], bugs: [{ id: "B1", location: "", repro: "", failingTest: "T", observed: "", expected: "" }] });
  assert.equal(gate({ artifact: exposing, verifiedTests: [ok("mvn test", 1)], allowFailingTestsWithBugs: true }).passed, true);
  const unexplained = art({ testCommands: [{ command: "mvn test", exitCode: 1 }] });
  assert.equal(gate({ artifact: unexplained, verifiedTests: [ok("mvn test", 1)], allowFailingTestsWithBugs: true }).passed, false);
});

test("gating: HEAD movement and branch changes pause", () => {
  const moved = gate({ after: snap({ head: "h2" }) });
  assert.equal(moved.passed, false);
  assert.equal(moved.pause, true);
  assert.equal(gate({ after: snap({ branch: "other" }) }).pause, true);
});

test("gating: read-only sessions must leave the checkout unchanged", () => {
  assert.equal(gate({ mode: "read-only", verifiedTests: [] }).passed, true);
  const touched = gate({ mode: "read-only", after: snap({ dirtyFingerprint: "other" }), verifiedTests: [] });
  assert.equal(touched.passed, false);
  assert.equal(touched.pause, true);
});

test("gating: confidentiality leak in working-tree diff content pauses the gate", () => {
  // The deny-listed term appears only in the diff CONTENT (not a file name and
  // not in the agent's self-reported changedFiles) \u2014 it must still be caught.
  const r = gate({ denyList: ["AcmeCorp"], added: addedIn("src/Foo.java", "// for AcmeCorp rollout") });
  assert.equal(r.passed, false);
  assert.equal(r.pause, true);
  assert.match(r.failures.join(), /"AcmeCorp" added in src\/Foo\.java/);
});

test("gating: submodule drift fails", () => {
  assert.equal(gate({ before: snap({ submoduleHead: "sub0" }), after: snap({ submoduleHead: "sub1" }) }).passed, false);
});

test("validateArtifact: rejects malformed artifacts instead of crashing the gate", () => {
  assert.equal(validateArtifact(null), null);
  assert.equal(validateArtifact({ status: "done" }), null);
  assert.equal(validateArtifact({ status: "DONE", testCommands: "x" }), null);
  assert.equal(validateArtifact({ status: "DONE", testCommands: [{ command: "mvn" }] }), null);
  const a = validateArtifact({ status: "DONE", summary: "s" });
  assert.deepEqual(a?.testCommands, []);
});

const THREE = `# Feature

## Implementation Plan

1. Add the column reader.
2. Wire up the WAL path.
3. Add integration tests.
`;

// ------------------------------------------------------------------ H1: confidentiality matching

test("confidentiality: case, separators and identifier embedding never hide a deny-listed term", () => {
  const deny = ["AcmeCorp", "trade_events"];
  for (const leak of [
    "class AcmeCorpIngestTest {}",
    'String t = "acmecorp_trades";',
    "acme_corp_trades",
    "test_trade_events_wal",
    "testTradeEventsOoo",
    "trade-events",
    "TRADE_EVENTS",
  ]) {
    assert.equal(scanForDenyTerms(leak, deny).length, 1, leak);
  }
  assert.equal(scanForDenyTerms("CREATE TABLE trades (ts TIMESTAMP)", deny).length, 0);
  // Multi-word terms and accents fold the same way on both sides.
  assert.ok(scanForDenyTerms("select from customerOrders", ["customer orders"]).length > 0);
  assert.ok(scanForDenyTerms("String owner = \"MULLER\";", ["Müller"]).length > 0);
  // A term without letters or digits would match everything; it is ignored.
  assert.equal(scanForDenyTerms("anything", ["--"]).length, 0);
});

/** A throwaway repo with one base commit; `g` runs git in it. */
function gitRepo(files: Record<string, string> = { "seed.txt": "seed\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "qfb-git-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  return { dir, g, git: new Git(dir), base: g(["rev-parse", "HEAD"]).trim() };
}

const leaksIn = (added: AddedContent, deny: string[]) =>
  confidentialityFailures(added, deny).filter((f) => f.startsWith("Confidentiality"));

test("git.addedContent: only added content is scanned; deleted and context lines never pause", () => {
  const { dir, git, base, g } = gitRepo({
    "Orders.java": "class Orders {\n  // legacy AcmeCorp hook\n  int x;\n}\n",
    "acme_corp_notes.txt": "old\n",
  });
  // Delete the line mentioning the term, edit next to it, and delete a file whose NAME has it.
  writeFileSync(join(dir, "Orders.java"), "class Orders {\n  int x;\n  int y;\n}\n");
  g(["rm", "-q", "acme_corp_notes.txt"]);
  assert.deepEqual(leaksIn(git.addedContent(base), ["AcmeCorp"]), []);
  assert.ok(git.changedFiles(base).includes("acme_corp_notes.txt"), "deletions still count for scope");

  // An added line, a new untracked file's content, and a new file NAME are all caught.
  writeFileSync(join(dir, "Orders.java"), "class Orders {\n  int x;\n  int acmeCorpId;\n}\n");
  assert.match(leaksIn(git.addedContent(base), ["AcmeCorp"]).join(), /added in Orders\.java/);
  writeFileSync(join(dir, "Orders.java"), "class Orders {\n  int x;\n}\n");
  writeFileSync(join(dir, "Fixture.sql"), "INSERT INTO TRADE_EVENTS VALUES (1);\n");
  writeFileSync(join(dir, "test_trade_events_wal.txt"), "neutral\n");
  const found = leaksIn(git.addedContent(base), ["trade events"]).join();
  assert.match(found, /Fixture\.sql/);
  assert.match(found, /test_trade_events_wal\.txt/);
});

test("git.addedContent: binary files fail closed (named, with a content digest)", () => {
  const { dir, git, base, g } = gitRepo({ "data.bin": "\0old" });
  writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 65, 99, 109, 101]));
  writeFileSync(join(dir, "new.bin"), Buffer.from([0, 0, 1]));
  const added = git.addedContent(base);
  assert.deepEqual(added.unscannable.map((u) => [u.path, u.reason]).sort(), [["data.bin", "binary"], ["new.bin", "binary"]]);
  assert.ok(added.unscannable.every((u) => /^[0-9a-f]{64}$/.test(u.digest)));
  assert.match(confidentialityFailures(added, ["AcmeCorp"]).join(), /Cannot check data\.bin .*binary.*a human must vet it/);
  // With nothing to look for, nothing has to be vetted.
  assert.deepEqual(confidentialityFailures(added, []), []);
  // A deleted binary is not new content.
  g(["rm", "-qf", "data.bin"]);
  assert.deepEqual(git.addedContent(base).unscannable.map((u) => u.path), ["new.bin"]);
});

test("git: a large cumulative diff (> 5 MiB) neither wedges snapshots nor hides a leak", () => {
  const { dir, git, base } = gitRepo({ "Big.java": "class Big {}\n" });
  const filler = Array.from({ length: 120_000 }, (_, i) => `  int field${i} = ${i}; // padding to make the diff big`).join("\n");
  writeFileSync(join(dir, "Big.java"), `class Big {\n${filler}\n  String t = "acme_corp_trades";\n}\n`);
  writeFileSync(join(dir, "Untracked.java"), filler);
  assert.ok(filler.length > 5 * 1024 * 1024);
  assert.match(git.snapshot(base).dirtyFingerprint, /^[0-9a-f]{16}$/);
  assert.ok(git.changedFiles(base).includes("Big.java"));
  assert.match(leaksIn(git.addedContent(base), ["AcmeCorp"]).join(), /added in Big\.java/);
});

test("git: a missing base fails loudly instead of falling back to a different comparison", () => {
  const { dir, git, base } = gitRepo();
  writeFileSync(join(dir, "seed.txt"), "changed\n");
  assert.equal(git.resolveCommit("HEAD"), base);
  for (const call of [
    () => git.resolveCommit("no-such-ref"),
    () => git.snapshot("no-such-ref"),
    () => git.changedFiles("no-such-ref"),
    () => git.addedContent("no-such-ref"),
  ]) {
    assert.throws(call, (e: unknown) => e instanceof GitError && /no-such-ref/.test(e.message));
  }
});

test("gating: an unscannable file fails the gate closed; it is the only failure, so it can be vetted", () => {
  const u: UnscannableFile = { path: "fixture.parquet", reason: "binary", digest: "d1" };
  const r = gate({ denyList: ["AcmeCorp"], added: addedIn("fixture.parquet", "", [u]) });
  assert.equal(r.passed, false);
  assert.equal(r.pause, true);
  assert.equal(r.vetOnly, true);
  assert.deepEqual(r.unscannable, [u]);
  // Alongside a real failure it is not "vet only".
  assert.equal(gate({ denyList: ["AcmeCorp"], added: addedIn("x", "AcmeCorp", [u]) }).vetOnly, false);
  // No deny-list: nothing to scan for.
  assert.equal(gate({ added: addedIn("fixture.parquet", "", [u]) }).passed, true);
});

// ------------------------------------------------------------------ H6: artifact identity

test("checkArtifact: an artifact from another run, step, kind, or an earlier time is rejected", () => {
  const startedAt = "2025-06-01T10:00:00.500Z";
  const expected = { runId: "run-1", stepId: "S2", kind: "implementation" as const, startedAt };
  const good = { ...art({ runId: "run-1", stepId: "S2" }), createdAt: "2025-06-01T10:05:00Z" };
  assert.equal(checkArtifact(good, expected).problem, null);
  // Second-precision timestamps written in the session's first second are fine.
  assert.equal(checkArtifact({ ...good, createdAt: "2025-06-01T10:00:00Z" }, expected).problem, null);
  for (const [over, why] of [
    [{ stepId: "S1" }, /stepId is "S1", expected "S2"/],
    [{ runId: "run-0" }, /runId/],
    [{ kind: "review" }, /kind/],
    [{ createdAt: "2025-06-01T09:00:00Z" }, /predates the session start/],
    [{ createdAt: "yesterday" }, /not an ISO-8601 timestamp/],
  ] as const) {
    const r = checkArtifact({ ...good, ...over }, expected);
    assert.equal(r.artifact, null);
    assert.match(r.problem!, why);
  }
  // The gate names the reason.
  assert.match(gate({ artifact: null, artifactProblem: "stepId is \"S1\", expected \"S2\"", verifiedTests: [] }).failures.join(), /No valid typed task handoff artifact.*stepId is "S1"/);
});

// ------------------------------------------------------------------ H3: plan extraction

test("plan: a '# comment' in a fenced code block is not a heading; list items keep their full bodies", () => {
  const doc = `# Feature

## Implementation Plan

1. Set up the fixture:

   \`\`\`bash
   # create the table
   ./setup.sh --rows 10
   \`\`\`

2. Implement the reader.
   It must handle nulls.
   - including empty partitions
3. Add tests.

## Acceptance criteria

1. Reader passes the fuzz suite.
`;
  const { steps, ambiguous } = extractPlan(doc);
  assert.equal(ambiguous, false);
  assert.deepEqual(steps.map((s) => s.text), [
    "Set up the fixture:\n\n```bash\n# create the table\n./setup.sh --rows 10\n```",
    "Implement the reader.\nIt must handle nulls.\n- including empty partitions",
    "Add tests.",
  ]);
});

test("plan: heading-delimited steps survive a bash comment inside a code fence", () => {
  const doc = "## Implementation Plan\n\n### Step 1 — fixture\n```bash\n# create the table\n./setup.sh\n```\n" +
    "### Step 2 — reader\nDo it.\n### Step 3 — tests\nTest it.\n";
  const { steps, strategy } = extractPlan(doc);
  assert.equal(strategy, "heading");
  assert.equal(steps.length, 3);
  assert.match(steps[0]!.text, /# create the table\n\.\/setup\.sh/);
});

test("plan: a second list, a numbering restart, or mixed list kinds is ambiguous", () => {
  const criteria = extractPlan("## Implementation Plan\n\n1. A.\n2. B.\n\nAcceptance criteria:\n\n1. A works.\n2. B works.\n");
  assert.equal(criteria.ambiguous, true);
  assert.equal(criteria.steps.length, 4); // still proposed, for explicit approval
  assert.ok(criteria.notes.some((n) => /separate lists/.test(n)));
  assert.equal(extractPlan("## Implementation Plan\n\n1. A.\n2. B.\n1. C.\n").ambiguous, true);
  assert.equal(extractPlan("## Implementation Plan\n\n1. A.\n- [ ] B.\n").ambiguous, true);
  // A prose paragraph between items that keep counting, or lazy "1." numbering, is one plan.
  assert.equal(extractPlan("## Implementation Plan\n\n1. A.\n\nNote on B:\n\n2. B.\n").ambiguous, false);
  assert.equal(extractPlan("## Implementation Plan\n\n1. A.\n1. B.\n1. C.\n").ambiguous, false);
});

// ------------------------------------------------------------------ M3: report surface

test("report: two qfb-review blocks or duplicate finding ids are ambiguous", () => {
  const block = (o: unknown) => "```qfb-review\n" + JSON.stringify(o) + "\n```\n";
  const approved = { verdict: "approved", testGatePassed: true, findings: [] };
  assert.throws(() => parseReviewReport("Example:\n" + block(approved) + "Actual:\n" + block(approved)), /2 qfb-review blocks/);
  const dup = { verdict: "blocking", testGatePassed: true, findings: [
    { id: "F1", severity: "critical", location: "A:1", evidence: "x" },
    { id: "F1", severity: "minor", location: "B:2", evidence: "y" },
  ] };
  assert.throws(() => parseReviewReport(block(dup)), (e: unknown) => e instanceof AmbiguousReportError && /"F1" appears more than once/.test(e.message));
});

// ------------------------------------------------------------------ F9: configuration

test("validateConfig: NaN, out-of-range, and unknown settings are rejected", () => {
  assert.doesNotThrow(() => validateConfig({ ...DEFAULT_CONFIG }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, reviewLevel: NaN }), /reviewLevel must be 0, 1, 2 or 3/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, reviewLevel: 7 }), /reviewLevel/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxImplAttemptsPerStep: 0 }), /maxImplAttemptsPerStep must be an integer >= 1/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxTotalSessions: 2.5 }), /maxTotalSessions/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, maxReviewIteration: 3 }), /unknown setting "maxReviewIteration"/);
});
