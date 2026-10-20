import { readFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { hostname } from "node:os";
import { spawnGroup, groupAlive, reapGroup, terminateGroup } from "../procs.ts";
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
  /**
   * Where Pi stores this session (and its nested subagents' sessions): inside
   * the run's artifact directory, so `qfb clean` removes them with the run.
   */
  sessionDir: string;
  inactivityTimeoutMs: number;
  /**
   * Called as soon as the session process exists, with its pid (which is also
   * its process-group id). The controller persists it so a restarted
   * controller can tell whether the session is still running.
   */
  onSpawn?: (pid: number) => void;
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

/** Durable identity of a launched session, as recorded in the state store. */
export interface SessionRef {
  sessionId: string;
  pid: number | null;
  host: string | null;
}

export interface PiAdapter {
  launch(req: PiLaunchRequest): Promise<PiLaunchResult>;
  /**
   * Whether the session (Pi plus anything it spawned) may still be running.
   * Must answer `true` whenever it cannot prove otherwise, so the controller
   * never starts a second writer next to a live one.
   */
  isRunning(ref: SessionRef): Promise<boolean>;
  /** Terminate the session's whole process tree. */
  terminate(ref: SessionRef): Promise<void>;
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
 * Real adapter using Pi's structured JSON mode (`pi --mode json --print`).
 * NOTE: Per Milestone 0 (Section 16) this backend must be *proven* to support
 * the nested subagents used by review-pr/fix-pr before relying on it for
 * stabilization. See docs/FEASIBILITY.md.
 */
export class RpcPiAdapter implements PiAdapter {
  async launch(req: PiLaunchRequest): Promise<PiLaunchResult> {
    const args = [
      "--mode", "json",
      "--print",
      "--session-id", req.sessionId,
      "--session-dir", req.sessionDir,
      "--name", `qfb-${req.runId}-${req.stepId}`,
    ];
    // Own process group: on timeout/stop we signal the whole tree, and on exit
    // we reap strays (e.g. a Maven fork) so nothing overlaps the next writer.
    const child = spawnGroup("pi", args, { cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid) req.onSpawn?.(pid);

    // CRITICAL: continuously drain stdout/stderr. If we leave them unread, a
    // verbose Pi session fills the OS pipe buffer (~64KB) and blocks forever.
    // Draining also gives us the durable session transcript (Section 13).
    const transcriptPath = `${req.artifactPath}.transcript.log`;
    const transcript = createWriteStream(transcriptPath, { flags: "a" });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const resetInactivity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Inactivity (no output) exceeded the budget. A timeout is not proof of
        // failure (Section 11); we terminate the whole tree so the controller
        // can reconcile and preserve any partial work rather than hang.
        timedOut = true;
        if (pid) void terminateGroup(pid);
      }, req.inactivityTimeoutMs);
    };
    resetInactivity();

    const onChunk = (buf: Buffer) => {
      transcript.write(buf);
      resetInactivity(); // activity seen → reset the inactivity window
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.stdin?.on("error", () => undefined); // EPIPE if Pi exits before reading
    child.stdin?.end(req.prompt);

    const exitCode: number | null = await new Promise((resolve) => {
      let code: number | null = null;
      child.on("error", () => resolve(null));
      child.on("exit", (c) => {
        code = c;
        if (pid) reapGroup(pid);
        // Fallback in case a stray somehow keeps the pipes open.
        setTimeout(() => resolve(code), 5000).unref();
      });
      child.on("close", () => resolve(code));
    });
    clearTimeout(timer);
    await new Promise<void>((r) => transcript.end(() => r()));

    const artifact = await readArtifact(req.artifactPath);
    return {
      sessionId: req.sessionId,
      settled: exitCode !== null,
      exitCode,
      timedOut,
      artifact,
      transcriptPath,
    };
  }

  async isRunning(ref: SessionRef): Promise<boolean> {
    // No pid recorded: the controller died before the process was spawned (the
    // pid is persisted immediately after spawn), so nothing can be running.
    if (ref.pid === null) return false;
    // Another host's process cannot be inspected from here; assume it lives.
    if (ref.host !== null && ref.host !== hostname()) return true;
    return groupAlive(ref.pid);
  }

  async terminate(ref: SessionRef): Promise<void> {
    if (ref.pid === null || (ref.host !== null && ref.host !== hostname())) return;
    await terminateGroup(ref.pid);
  }
}
