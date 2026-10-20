import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GitSnapshot } from "./types.ts";

/**
 * Thin, read-mostly Git wrapper enforcing the safety rules of Section 7.
 * Destructive commands (hard reset, clean -f, force checkout) are intentionally
 * absent — the controller must NEVER run them automatically.
 */
export class Git {
  private readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private run(args: string[]): string {
    return execFileSync("git", args, { cwd: this.cwd, encoding: "utf8" }).trim();
  }

  branch(): string {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }

  isClean(): boolean {
    return this.run(["status", "--porcelain"]).length === 0;
  }

  /** Merge-base of HEAD and the given ref; used to anchor the feature base. */
  mergeBase(ref: string): string {
    return this.run(["merge-base", "HEAD", ref]);
  }

  /** Best-effort default integration branch (origin/HEAD target, else master). */
  defaultBase(): string {
    try {
      const sym = this.run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      const m = /refs\/remotes\/origin\/(.+)$/.exec(sym);
      if (m) return m[1]!;
    } catch {
      // ignore
    }
    return "master";
  }

  untrackedFiles(): string[] {
    const out = this.run(["ls-files", "--others", "--exclude-standard"]);
    return out ? out.split("\n") : [];
  }

  submoduleHead(path = "java-questdb-client"): string | null {
    try {
      // Read the submodule's own HEAD; it is a separate repository.
      return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
        cwd: this.cwd,
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  }

  /** Combined fingerprint of tracked diff + untracked content (Section 7). */
  private dirtyFingerprint(base: string): string {
    let diff = "";
    try {
      diff = this.run(["diff", base]);
    } catch {
      diff = this.run(["diff"]);
    }
    const untracked = this.untrackedFiles().sort().join("\n");
    return createHash("sha256").update(diff + "\n--untracked--\n" + untracked).digest("hex").slice(0, 16);
  }

  snapshot(base: string): GitSnapshot {
    return {
      branch: this.branch(),
      head: this.head(),
      dirtyFingerprint: this.dirtyFingerprint(base),
      submoduleHead: this.submoduleHead(),
      untrackedFiles: this.untrackedFiles(),
    };
  }

  stagedDiff(): string {
    return this.run(["diff", "--cached"]);
  }

  /**
   * Create a non-destructive checkpoint commit (commit policy only). The caller
   * must have already passed the scope/integrity gate. We never push, rebase,
   * or alter history.
   */
  commitCheckpoint(message: string, files: string[]): string {
    if (files.length === 0) return this.head();
    this.run(["add", "--", ...files]);
    this.run(["commit", "-m", message]);
    return this.head();
  }
}
