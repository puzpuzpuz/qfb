import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellTestRunner, groupAlive } from "../src/procs.ts";
import { RpcPiAdapter } from "../src/adapters/pi.ts";
import { Git } from "../src/git.ts";
import { pushBlocker, openPrIfNone, postReviewComment, reviewCommentBody } from "../src/pr.ts";
import type { PrRequest } from "../src/pr.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "qfb-procs-"));

test("shellTestRunner returns the real exit code and captures output", async () => {
  const d = tmp();
  const log = join(d, "t.log");
  assert.equal(await shellTestRunner("echo hello; exit 3", d, log, 10_000), 3);
  assert.match(readFileSync(log, "utf8"), /hello[\s\S]*exit=3/);
});

test("shellTestRunner reaps background strays so nothing outlives the command", async () => {
  const d = tmp();
  const pidFile = join(d, "stray.pid");
  const t0 = Date.now();
  assert.equal(await shellTestRunner(`sleep 30 & echo $! > ${pidFile}; exit 0`, d, join(d, "t.log"), 10_000), 0);
  assert.ok(Date.now() - t0 < 5000, "must not wait for the stray");
  const stray = Number(readFileSync(pidFile, "utf8"));
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(stray, 0), "stray must be dead");
});

test("shellTestRunner kills the whole group on timeout", async () => {
  const d = tmp();
  assert.equal(await shellTestRunner("sleep 30", d, join(d, "t.log"), 200), 124);
});

/** Put a stand-in executable `name` first on PATH. */
function fakeBin(dir: string, name: string, body: string): void {
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** A stand-in `pi` that writes its artifact, leaves a stray behind, and exits. */
function fakePi(dir: string, body: string): void {
  fakeBin(dir, "pi", body);
}

test("RpcPiAdapter: own process group, pid reported, artifact read, strays reaped", async () => {
  const d = tmp();
  const artifactPath = join(d, "a.json");
  const strayFile = join(d, "stray.pid");
  const argsFile = join(d, "args");
  fakePi(d, `printf '%s\\n' "$@" > ${argsFile}; cat >/dev/null; sleep 30 & echo $! > ${strayFile}; echo '{"status":"DONE"}' > ${artifactPath}; exit 0`);
  let spawned = 0;
  const pi = new RpcPiAdapter();
  const sessionDir = join(d, "pi-sessions");
  const r = await pi.launch({
    runId: "r", stepId: "S1", cwd: d, prompt: "p", sessionId: "s1", artifactPath, sessionDir,
    inactivityTimeoutMs: 10_000, onSpawn: (pid) => (spawned = pid),
  });
  // Pi keeps its session files where QFB says, so `qfb clean` can remove them.
  const argv = readFileSync(argsFile, "utf8").split("\n");
  assert.equal(argv[argv.indexOf("--session-dir") + 1], sessionDir);
  assert.ok(spawned > 0);
  assert.equal(r.settled, true);
  assert.equal(r.artifact?.status, "DONE");
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(groupAlive(spawned), false, "the stray in Pi's group must be reaped");
  assert.equal(await pi.isRunning({ sessionId: "s1", pid: spawned, host: null }), false);
  assert.equal(await pi.isRunning({ sessionId: "x", pid: 1, host: "some-other-host" }), true);
});

test("RpcPiAdapter.terminate kills a live session tree (used by `qfb stop`)", async () => {
  const d = tmp();
  fakePi(d, "cat >/dev/null; sleep 60");
  const pi = new RpcPiAdapter();
  let pid = 0;
  const pending = pi.launch({
    runId: "r", stepId: "S1", cwd: d, prompt: "p", sessionId: "s2", artifactPath: join(d, "b.json"),
    sessionDir: join(d, "pi-sessions"),
    inactivityTimeoutMs: 60_000, onSpawn: (p) => (pid = p),
  });
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(await pi.isRunning({ sessionId: "s2", pid, host: null }), true);
  await pi.terminate({ sessionId: "s2", pid, host: null });
  const r = await pending;
  assert.equal(r.settled, false);
  assert.equal(groupAlive(pid), false);
});

function repo(): { dir: string; git: Git; base: string } {
  const dir = tmp();
  const g = (a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "feature/x"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  return { dir, git: new Git(dir), base: g(["rev-parse", "HEAD"]).trim() };
}

test("Git.commitAll commits the gated tree and is a no-op when nothing changed", () => {
  const { dir, git } = repo();
  const h0 = git.head();
  assert.equal(git.commitAll("noop"), h0);
  writeFileSync(join(dir, "b.txt"), "b\n");
  const h1 = git.commitAll("[qfb] S1: add b");
  assert.notEqual(h1, h0);
  assert.equal(git.isClean(), true);
});

test("Git exclude: local docs are invisible to gates and fingerprints, and never committed", () => {
  const { dir, base } = repo();
  // The design lives in the checkout under an awkward name; another doc is tracked and edited.
  const design = "HANDOFF [lv]*.md";
  writeFileSync(join(dir, "notes.md"), "v1\n");
  execFileSync("git", ["add", "notes.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "notes"], { cwd: dir });
  const git = new Git(dir, { exclude: [design, "notes.md"] });
  const fp0 = git.snapshot(base).dirtyFingerprint;
  writeFileSync(join(dir, design), "AcmeCorp design\n");
  writeFileSync(join(dir, "notes.md"), "v2 AcmeCorp\n");
  execFileSync("git", ["add", "notes.md"], { cwd: dir }); // the operator staged it themselves

  assert.equal(git.isClean(), true);
  assert.deepEqual(git.changedFiles(base), []);
  assert.deepEqual(git.addedContent(base).files, []);
  assert.equal(git.snapshot(base).dirtyFingerprint, fp0, "editing a local doc is not a checkout change");

  writeFileSync(join(dir, "b.txt"), "feature\n");
  assert.deepEqual(git.changedFiles(base), ["b.txt"]);
  git.commitAll("[qfb] S1");
  const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf8" });
  assert.deepEqual(committed.trim().split("\n"), ["b.txt"]);
  // Both docs keep their content in the working tree, uncommitted.
  assert.equal(readFileSync(join(dir, design), "utf8"), "AcmeCorp design\n");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.match(status, /^ M notes\.md$/m);
  assert.match(status, /^\?\? "HANDOFF \[lv\]\*\.md"$/m);
  assert.equal(git.isClean(), true);
});

test("pushBlocker: only the exact reviewed commit, clean, on the run's branch, under commit policy", () => {
  const { dir, git, base } = repo();
  writeFileSync(join(dir, "b.txt"), "b\n");
  const head = git.commitAll("[qfb] S1");
  const accepted = { branch: "feature/x", head, fingerprint: git.snapshot(base).dirtyFingerprint };
  const req: PrRequest = {
    branch: "feature/x", prBase: "master", featureBase: base, title: "t", body: "b",
    accepted, checkpointPolicy: "commit", denyList: ["AcmeCorp"],
  };
  assert.equal(pushBlocker(git, req), null);
  assert.match(pushBlocker(git, { ...req, checkpointPolicy: "snapshot" })!, /snapshot checkpoints/);
  assert.match(pushBlocker(git, { ...req, accepted: null })!, /no accepted candidate/);
  writeFileSync(join(dir, "c.txt"), "unreviewed\n");
  assert.match(pushBlocker(git, req)!, /uncommitted or untracked/);
  git.commitAll("sneaky");
  assert.match(pushBlocker(git, req)!, /is not the reviewed commit/);
  // Deny-listed PR text is refused before anything is pushed.
  const r = openPrIfNone(dir, git, { ...req, title: "feat: AcmeCorp ingest" });
  assert.equal(r.opened, false);
  assert.match(r.reason, /deny-listed/);
});

test("openPrIfNone pushes the accepted commit to an already-open PR instead of leaving it stale", () => {
  const { dir, git, base } = repo();
  const remote = tmp();
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["push", "-q", "origin", "feature/x"], { cwd: dir, stdio: "ignore" }); // the PR as first opened
  writeFileSync(join(dir, "b.txt"), "b\n");
  const head = git.commitAll("[qfb] S1");
  const created = join(dir, "..", "pr-created");
  fakeBin(tmp(), "gh", [
    `case "$1 $2" in`,
    `  "pr list") echo '[{"url":"https://example.test/pr/7"}]' ;;`,
    `  "pr create") touch ${created}; exit 1 ;;`,
    `esac`,
  ].join("\n"));
  const r = openPrIfNone(dir, git, {
    branch: "feature/x", prBase: "master", featureBase: base, title: "t", body: "b",
    accepted: { branch: "feature/x", head, fingerprint: git.snapshot(base).dirtyFingerprint },
    checkpointPolicy: "commit", denyList: [],
  });
  assert.deepEqual([r.opened, r.pushed, r.url], [false, true, "https://example.test/pr/7"]);
  assert.match(r.reason, /pushed the accepted commit to the already-open PR/);
  assert.equal(execFileSync("git", ["rev-parse", "feature/x"], { cwd: remote, encoding: "utf8" }).trim(), head);
  assert.throws(() => readFileSync(created), "no second PR is created");
});

const REVIEW_REPORT =
  "# Review\n\nLooks good.\n\n- **Verdict: approve with comments.**\n\n" +
  "```qfb-review\n" + JSON.stringify({ verdict: "approve with comments", testGatePassed: true, findings: [] }) + "\n```\n";

test("postReviewComment posts the approving review, without its qfb-review block, on the PR", () => {
  const d = tmp();
  const reportPath = join(d, "review-5.json.report.md");
  writeFileSync(reportPath, REVIEW_REPORT);
  const argsFile = join(d, "gh-args");
  const bodyFile = join(d, "gh-body");
  fakeBin(tmp(), "gh", `printf '%s\\n' "$@" > ${argsFile}; cat > ${bodyFile}`);
  const review = { iteration: 5, reportPath, head: "7709a41f44c3313a034a43b9459e41ca5bd4a126" };
  const r = postReviewComment(d, "https://example.test/pr/7", "run-1", review, ["AcmeCorp"]);
  assert.deepEqual([r.posted, r.retryable], [true, false]);
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), ["pr", "comment", "https://example.test/pr/7", "--body-file", "-"]);
  const body = readFileSync(bodyFile, "utf8");
  assert.match(body, /^### QFB review: approve with comments\n/);
  assert.match(body, /iteration 5\) of `7709a41f44c3` by QFB run `run-1`/);
  assert.match(body, /Looks good\.[\s\S]*Verdict: approve with comments/);
  assert.doesNotMatch(body, /qfb-review|testGatePassed/);

  // A deny-listed term in the report: nothing is posted.
  writeFileSync(reportPath, REVIEW_REPORT.replace("Looks good.", "Covers the AcmeCorp table."));
  writeFileSync(bodyFile, "");
  const leak = postReviewComment(d, "https://example.test/pr/7", "run-1", review, ["AcmeCorp"]);
  assert.deepEqual([leak.posted, leak.retryable], [false, false]);
  assert.match(leak.reason, /deny-listed term\(s\) "AcmeCorp"/);
  assert.equal(readFileSync(bodyFile, "utf8"), "");

  // gh failing is reported, and worth retrying.
  writeFileSync(reportPath, REVIEW_REPORT);
  fakeBin(tmp(), "gh", "echo 'HTTP 502' >&2; exit 1");
  const failed = postReviewComment(d, "https://example.test/pr/7", "run-1", review, []);
  assert.deepEqual([failed.posted, failed.retryable], [false, true]);
  assert.match(failed.reason, /gh pr comment failed/);
});

test("reviewCommentBody keeps a long report under GitHub's comment limit", () => {
  const raw = "# Review\n\n" + "x".repeat(100_000) + "\n\n" + REVIEW_REPORT;
  const body = reviewCommentBody("run-1", { iteration: 1, reportPath: "/r", head: "abc" }, raw);
  assert.ok(body.length <= 60_001, `${body.length}`);
  assert.match(body, /Truncated; the full report is in QFB's artifacts for run `run-1`/);
});

test("CLI: --level is validated (no NaN or out-of-range review level reaches a run)", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/index.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, QFB_DB: join(tmp(), "q.sqlite"), QFB_ARTIFACTS: tmp() },
    });
  for (const level of [["--level", "7"], ["--level", "two"], ["--level"]]) {
    const r = cli(["init", "--repo", tmp(), "--design", "d.md", "--base", "HEAD", ...level]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--level must be 0, 1, 2 or 3/);
  }
});
