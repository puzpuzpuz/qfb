import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * Process-group management. Every Pi session and every controller-run test
 * command is spawned as the leader of its own process group, so the whole tree
 * it starts (Maven, forked JVMs, cargo, …) can be signalled and reaped as one
 * unit. This is what lets QFB guarantee that a timed-out, stopped, or finished
 * session leaves nothing behind that could overlap with the next writer or a
 * concurrent Maven run in the same checkout.
 */

/** Groups we spawned and have not yet reaped. */
const owned = new Set<number>();

export function spawnGroup(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: true });
  if (child.pid) owned.add(child.pid);
  return child;
}

/** True while any process in group `pgid` is alive. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone
  }
}

/** Reap whatever a finished group leader left behind, and stop tracking it. */
export function reapGroup(pgid: number): void {
  signalGroup(pgid, "SIGKILL");
  owned.delete(pgid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the group, escalate to SIGKILL after `graceMs`, and wait until it is gone. */
export async function terminateGroup(pgid: number, graceMs = 5000): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  const hard = Date.now() + 2000;
  while (groupAlive(pgid) && Date.now() < hard) await sleep(50);
}

/**
 * Best-effort, synchronous: SIGTERM every group we still own. Runs on process
 * exit (including the SIGINT/SIGTERM/SIGHUP handlers installed by the CLI), so
 * a controller that is interrupted does not leave detached writers running.
 * If one survives anyway (or the controller is SIGKILLed), the next controller
 * detects it from the recorded pid and enters reconciliation.
 */
export function terminateOwnedGroups(): void {
  for (const g of owned) signalGroup(g, "SIGTERM");
}

process.on("exit", terminateOwnedGroups);

/** Runs one validation command; resolves to its REAL exit code. */
export type TestRunner = (command: string, cwd: string, logPath: string, timeoutMs: number) => Promise<number>;

/**
 * Default TestRunner: `sh -c <command>` in its own process group, output
 * captured to `logPath`. A timeout or signal death maps to a nonzero code.
 * Callers run these strictly one at a time (no concurrent Maven).
 */
export const shellTestRunner: TestRunner = (command, cwd, logPath, timeoutMs) =>
  new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: "w" });
    log.write(`$ ${command}\n`);
    const child = spawnGroup("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) void terminateGroup(pid);
    }, timeoutMs);
    let exit: number | null = null;
    let sig: NodeJS.Signals | null = null;
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Resolve only once the log is flushed: callers read it as evidence.
      log.end(`\n[qfb] exit=${exit ?? "-"} signal=${sig ?? "-"}${timedOut ? " (timed out)" : ""}\n`, () => resolve(code));
    };
    child.on("error", (e) => {
      log.write(`[qfb] failed to start: ${e.message}\n`);
      finish(127);
    });
    child.on("exit", (code, signal) => {
      exit = code;
      sig = signal;
      // Kill strays that still hold the pipes so 'close' fires.
      if (pid) reapGroup(pid);
    });
    child.on("close", () => finish(timedOut ? 124 : exit ?? 128));
  });
