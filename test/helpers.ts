import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Controller } from "../src/controller.ts";
import { NullHerdrAdapter } from "../src/adapters/herdr.ts";
import type { GitLike } from "../src/controller.ts";
import type { PiAdapter, PiLaunchRequest, PiLaunchResult } from "../src/adapters/pi.ts";
import type { GitSnapshot, TaskArtifact } from "../src/types.ts";

/** Mutable fake Git whose snapshot() reflects the current shared state. */
export class FakeGit implements GitLike {
  state = {
    branch: "feature/x",
    head: "deadbeef",
    fingerprint: "fp0",
    submoduleHead: "sub0" as string | null,
    stagedDiff: "",
  };
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
  stagedDiff() {
    return this.state.stagedDiff;
  }
  isClean() {
    return this.state.fingerprint === "fp0";
  }
  commitCheckpoint(_m: string, _f: string[]) {
    this.state.head = "commit-" + Math.random().toString(16).slice(2, 8);
    return this.state.head;
  }
}

export type PiHandler = (req: PiLaunchRequest, git: FakeGit) => Partial<PiLaunchResult> & { settled?: boolean };

/**
 * Scripted mock Pi adapter. Each launch consumes the next handler from the
 * queue (or a default). Handlers may mutate the shared FakeGit to simulate
 * code changes, and return the artifact/launch result the controller sees.
 */
export class MockPi implements PiAdapter {
  launches: PiLaunchRequest[] = [];
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
    this.running.delete(req.sessionId);
    return result;
  }
  async isRunning(id: string) {
    return this.running.has(id);
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
  designPath: string;
}

export function makeHarness(design: string, handlers: PiHandler[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), "qfb-test-"));
  const designPath = join(dir, "design.md");
  writeFileSync(designPath, design);
  const store = new Store(join(dir, "state.sqlite"));
  const git = new FakeGit();
  const pi = new MockPi(git, handlers);
  const controller = new Controller({
    store,
    pi,
    herdr: new NullHerdrAdapter(),
    makeGit: () => git,
    artifactRoot: join(dir, "artifacts"),
  });
  return { dir, store, controller, git, pi, designPath };
}

export const THREE_STEP_DESIGN = `# Feature

## Implementation Plan

1. Add the column reader.
2. Wire up the WAL path.
3. Add integration tests.
`;
