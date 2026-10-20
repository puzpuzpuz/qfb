import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TaskArtifact } from "../types.ts";

/**
 * Pi execution adapter (Section 4.2).
 *
 * The controller trusts exactly ONE completion signal: the durable, typed task
 * artifact on disk — never "prompt accepted", "turn ended", or "run settled".
 * The adapter's job is to launch a fresh Pi session, wait for the process to
 * settle, and hand back the structured lifecycle events it observed. The
 * controller then reads and gates on the artifact itself.
 */
export interface PiLaunchRequest {
  runId: string;
  stepId: string;
  /** Working directory = QuestDB checkout. */
  cwd: string;
  /** Compact, self-contained instruction (Section 6). */
  prompt: string;
  /** Deterministic session id so a retried action cannot duplicate a session. */
  sessionId: string;
  /** Where the agent must write its typed artifact. */
  artifactPath: string;
  inactivityTimeoutMs: number;
}

export interface PiLaunchResult {
  sessionId: string;
  /** Process settled (exited) — NOT proof of logical completion. */
  settled: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Parsed artifact if present and valid; the authoritative completion signal. */
  artifact: TaskArtifact | null;
  /** Raw final transcript / events path for observability. */
  transcriptPath: string | null;
}

export interface PiAdapter {
  launch(req: PiLaunchRequest): Promise<PiLaunchResult>;
  /** Check whether a session with this id is still actively running. */
  isRunning(sessionId: string): Promise<boolean>;
}

async function readArtifact(path: string): Promise<TaskArtifact | null> {
  if (!existsSync(path)) return null;
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt) as TaskArtifact;
  } catch {
    return null;
  }
}

/**
 * Real adapter using Pi's structured RPC/JSON mode (`pi --mode rpc -p`).
 * NOTE: Per Milestone 0 (Section 16) the RPC backend must be *proven* to
 * support the nested subagents used by review-pr/fix-pr before relying on it
 * for stabilization. See docs/FEASIBILITY.md.
 */
export class RpcPiAdapter implements PiAdapter {
  private readonly running = new Set<string>();

  async launch(req: PiLaunchRequest): Promise<PiLaunchResult> {
    this.running.add(req.sessionId);
    const args = [
      "--mode", "json",
      "--print",
      "--session-id", req.sessionId,
      "--name", `qfb-${req.runId}-${req.stepId}`,
    ];
    const child = spawn("pi", args, { cwd: req.cwd });
    child.stdin.write(req.prompt);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Do not kill mid-write blindly; a timeout is not proof of failure
      // (Section 11). We detach and let the controller reconcile.
    }, req.inactivityTimeoutMs);

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    clearTimeout(timer);
    this.running.delete(req.sessionId);

    const artifact = await readArtifact(req.artifactPath);
    return {
      sessionId: req.sessionId,
      settled: exitCode !== null,
      exitCode,
      timedOut,
      artifact,
      transcriptPath: null,
    };
  }

  async isRunning(sessionId: string): Promise<boolean> {
    return this.running.has(sessionId);
  }
}
