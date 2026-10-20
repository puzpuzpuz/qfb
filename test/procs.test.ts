import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellTestRunner, groupAlive } from "../src/procs.ts";
import { RpcPiAdapter } from "../src/adapters/pi.ts";
import { Git } from "../src/git.ts";
import { pushBlocker, openPrIfNone } from "../src/pr.ts";
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

/** A stand-in `pi` that writes its artifact, leaves a stray behind, and exits. */
function fakePi(dir: string, body: string): void {
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

test("RpcPiAdapter: own process group, pid reported, artifact read, strays reaped", async () => {
  const d = tmp();
  const artifactPath = join(d, "a.json");
  const strayFile = join(d, "stray.pid");
  fakePi(d, `cat >/dev/null; sleep 30 & echo $! > ${strayFile}; echo '{"status":"DONE"}' > ${artifactPath}; exit 0`);
  let spawned = 0;
  const pi = new RpcPiAdapter();
  const r = await pi.launch({
    runId: "r", stepId: "S1", cwd: d, prompt: "p", sessionId: "s1", artifactPath,
    inactivityTimeoutMs: 10_000, onSpawn: (pid) => (spawned = pid),
  });
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
