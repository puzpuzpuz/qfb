import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Controller } from "../src/controller.ts";
import { NullHerdrAdapter } from "../src/adapters/herdr.ts";
import type { GitLike } from "../src/controller.ts";
import type { PiAdapter, PiLaunchRequest, PiLaunchResult, SessionRef } from "../src/adapters/pi.ts";
import type { GitSnapshot, TaskArtifact } from "../src/types.ts";

/** Mutable fake Git whose snapshot() reflects the current shared state. */
export class FakeGit implements GitLike {
  state = {
    branch: "feature/x",
    head: "deadbeef",
    fingerprint: "fp0",
    submoduleHead: "sub0" as string | null,
    changedFiles: [] as string[],
    diffText: "",
    /** Test names that currently fail for real (e.g. tests exposing an open bug). */
    failing: [] as string[],
  };
  commits: string[] = [];
  branch() {
    return this.state.branch;
  }
  head() {
    return this.state.head;
  }
  snapshot(_base: string): GitSnapshot {
    return {
      branch: this.state.branch,
      head: this.state.head,
      dirtyFingerprint: this.state.fingerprint,
      submoduleHead: this.state.submoduleHead,
      untrackedFiles: [],
    };
  }
  changedFiles(_base: string) {
    return this.state.changedFiles;
  }
  workingDiff(_base: string) {
    return this.state.diffText;
  }
  isClean() {
    return this.state.fingerprint === "fp0";
  }
  commitAll(message: string) {
    this.commits.push(message);
    this.state.head = "commit-" + this.commits.length;
    return this.state.head;
  }
}

/**
 * Scripted validation-command runner: the REAL exit code per command. By
 * default a command fails iff it names a test in `git.state.failing`.
 */
export class FakeTests {
  ran: string[] = [];
  exitFor: (command: string) => number;
  constructor(git: FakeGit) {
    this.exitFor = (c) => (git.state.failing.some((t) => c.includes(`-Dtest=${t} `)) ? 1 : 0);
  }
  run = async (command: string, _cwd: string, logPath: string): Promise<number> => {
    this.ran.push(command);
    const code = this.exitFor(command);
    writeFileSync(logPath, `$ ${command}\nexit ${code}\n`);
    return code;
  };
}

export type PiHandler = (req: PiLaunchRequest, git: FakeGit) => Partial<PiLaunchResult> & { settled?: boolean };

/**
 * Scripted mock Pi adapter. Each launch consumes the next handler from the
 * queue (or a default). Handlers may mutate the shared FakeGit to simulate
 * code changes, and return the artifact/launch result the controller sees.
 * Like real Pi, the artifact is also written to the requested path on disk.
 */
export class MockPi implements PiAdapter {
  launches: PiLaunchRequest[] = [];
  terminated: string[] = [];
  /** Sessions that outlived their controller (simulated orphans). */
  orphans = new Set<string>();
  private queue: PiHandler[] = [];
  private running = new Set<string>();
  private git: FakeGit;
  constructor(git: FakeGit, handlers: PiHandler[] = []) {
    this.git = git;
    this.queue = [...handlers];
  }
  push(h: PiHandler) {
    this.queue.push(h);
  }
  async launch(req: PiLaunchRequest): Promise<PiLaunchResult> {
    this.launches.push(req);
    this.running.add(req.sessionId);
    req.onSpawn?.(40000 + this.launches.length);
    const h = this.queue.shift();
    const base: PiLaunchResult = {
      sessionId: req.sessionId,
      settled: true,
      exitCode: 0,
      timedOut: false,
      artifact: null,
      transcriptPath: null,
    };
    const result = h ? { ...base, ...h(req, this.git) } : base;
    if (result.artifact) writeFileSync(req.artifactPath, JSON.stringify(result.artifact));
    this.running.delete(req.sessionId);
    return result;
  }
  async isRunning(ref: SessionRef) {
    return this.running.has(ref.sessionId) || this.orphans.has(ref.sessionId);
  }
  async terminate(ref: SessionRef) {
    this.terminated.push(ref.sessionId);
    this.orphans.delete(ref.sessionId);
  }
}

export function artifact(partial: Partial<TaskArtifact>): TaskArtifact {
  return {
    runId: "r",
    stepId: "s",
    kind: "implementation",
    status: "DONE",
    summary: "did the thing",
    changedFiles: ["src/Foo.java"],
    testCommands: [{ command: "mvn -q test -pl core", exitCode: 0, logPath: "/tmp/log" }],
    limitations: [],
    notableDecisions: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export interface Harness {
  dir: string;
  store: Store;
  controller: Controller;
  git: FakeGit;
  pi: MockPi;
  tests: FakeTests;
  designPath: string;
  /** A second controller on the same DB, as another `qfb` process would be. */
  other(): Controller;
}

export function makeHarness(design: string, handlers: PiHandler[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), "qfb-test-"));
  const designPath = join(dir, "design.md");
  writeFileSync(designPath, design);
  const dbPath = join(dir, "state.sqlite");
  const store = new Store(dbPath);
  const git = new FakeGit();
  const pi = new MockPi(git, handlers);
  const tests = new FakeTests(git);
  const make = (s: Store) =>
    new Controller({
      store: s,
      pi,
      herdr: new NullHerdrAdapter(),
      makeGit: () => git,
      artifactRoot: join(dir, "artifacts"),
      runTest: tests.run,
      orphanGraceMs: 0,
    });
  const controller = make(store);
  return { dir, store, controller, git, pi, tests, designPath, other: () => make(new Store(dbPath)) };
}

export const THREE_STEP_DESIGN = `# Feature

## Implementation Plan

1. Add the column reader.
2. Wire up the WAL path.
3. Add integration tests.
`;
