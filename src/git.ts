import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";
import type { AddedContent, GitSnapshot, UnscannableFile } from "./types.ts";

/**
 * Untracked files larger than this are not read into memory for the
 * confidentiality scan; they are reported as unscannable (the gate fails closed).
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Git output buffer. The cumulative feature diff grows with the run; the 1 MiB
 * default made every step fail once it was crossed.
 */
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * Diff flags that make output independent of the user's Git configuration
 * (colour, external diff drivers, textconv filters, rename detection, path
 * prefixes), so it can be parsed and hashed reliably.
 */
const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/** A git command failed. The controller pauses on this; it never substitutes a fallback. */
export class GitError extends Error {
  readonly args: string[];
  constructor(args: string[], detail: string) {
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.args = args;
  }
}

/**
 * Thin, read-mostly Git wrapper enforcing the safety rules of Section 7.
 * Destructive commands (hard reset, clean -f, force checkout) are intentionally
 * absent — the controller must NEVER run them automatically.
 *
 * Every method that feeds a gate throws GitError on failure: there are no
 * silent fallbacks (e.g. to `git diff` without the base), because a different
 * comparison or an empty result would make the gate pass when it should not.
 */
export class Git {
  private readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Raw stdout of a git command. */
  private exec(args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
      throw new GitError(args, (stderr || err.message).split("\n").slice(0, 3).join(" | "));
    }
  }

  private run(args: string[]): string {
    return this.exec(args).trim();
  }

  /** NUL-separated output (`-z`) as a list, so unusual path names are never quoted or split. */
  private list(args: string[]): string[] {
    return this.exec(args).split("\0").filter(Boolean);
  }

  branch(): string {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }

  isClean(): boolean {
    return this.run(["status", "--porcelain", "--untracked-files=normal"]).length === 0;
  }

  /** Merge-base of HEAD and the given ref; used to anchor the feature base. */
  mergeBase(ref: string): string {
    return this.run(["merge-base", "HEAD", ref]);
  }

  /** The commit SHA a ref names. Throws GitError when it does not resolve to a commit. */
  resolveCommit(ref: string): string {
    return this.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
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
    return this.list(["ls-files", "-z", "--others", "--exclude-standard"]);
  }

  submoduleHead(path = "java-questdb-client"): string | null {
    try {
      // Read the submodule's own HEAD; it is a separate repository.
      return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
        cwd: this.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Combined fingerprint of the tracked diff against base (binary content
   * included) plus the CONTENT of every untracked file (Section 7).
   */
  private dirtyFingerprint(base: string): string {
    const h = createHash("sha256");
    h.update(this.exec(["diff", "--binary", ...PLAIN_DIFF, base]));
    h.update("\0--untracked--\0");
    for (const f of this.untrackedFiles().sort()) {
      // Hash untracked file CONTENT (not just names) so an edit to an untracked
      // file flips the fingerprint; otherwise the "checkout changed during
      // review" / stale-result guard could miss same-filename content changes.
      h.update(`${f}\0${this.digest(f)}\n`);
    }
    return h.digest("hex").slice(0, 16);
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

  /**
   * Authoritative list of paths changed versus `base`: tracked modifications
   * and deletions (working tree vs base) plus untracked files. Used by the
   * mechanical gate for scope checks instead of the agent's self-report.
   */
  changedFiles(base: string): string[] {
    const tracked = this.list(["diff", "--name-only", "-z", ...PLAIN_DIFF, base]);
    return [...new Set([...tracked, ...this.untrackedFiles()])];
  }

  /**
   * What the confidentiality gate scans: for each added or modified tracked
   * file, only the lines the change adds versus `base`; for each untracked
   * file, its whole content. Deleted files and removed/context lines are
   * excluded. Anything that cannot be read as text (binary, too large,
   * unreadable) is reported in `unscannable` rather than skipped.
   */
  addedContent(base: string): AddedContent {
    const added = new Map<string, string[]>();
    const unscannable: UnscannableFile[] = [];

    // Added/modified tracked paths (deletions excluded); "-" counts mark binary files.
    for (const rec of this.list(["diff", "--numstat", "-z", "--diff-filter=d", ...PLAIN_DIFF, base])) {
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec);
      if (!m) throw new GitError(["diff", "--numstat"], `unexpected output record ${JSON.stringify(rec.slice(0, 80))}`);
      const path = m[3]!;
      added.set(path, []);
      if (m[1] === "-") unscannable.push({ path, reason: "binary", digest: this.digest(path) });
    }

    // Added lines of the text diffs (-U0: no context lines).
    let current: string[] | null = null;
    let inHunk = false;
    for (const line of this.exec(["diff", "-U0", "--diff-filter=d", ...PLAIN_DIFF, base]).split("\n")) {
      if (line.startsWith("diff --git ")) {
        const path = diffHeaderPath(line);
        current = added.get(path) ?? null;
        if (current === null) {
          added.set(path, []);
          current = added.get(path)!;
        }
        inHunk = false;
      } else if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && line.startsWith("+") && current) {
        current.push(line.slice(1));
      }
    }

    for (const f of this.untrackedFiles()) {
      const r = this.readUntracked(f);
      if (r === null) continue; // vanished between listing and reading: nothing left to leak
      if ("text" in r) added.set(f, [r.text]);
      else {
        added.set(f, []);
        unscannable.push({ path: f, reason: r.reason, digest: r.digest });
      }
    }

    return { files: [...added].map(([path, lines]) => ({ path, added: lines.join("\n") })), unscannable };
  }

  /** Read an untracked file for scanning, or say why it cannot be scanned. */
  private readUntracked(f: string): { text: string } | { reason: string; digest: string } | null {
    const abs = join(this.cwd, f);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return { text: readlinkSync(abs) }; // git records the link target
      if (!st.isFile()) return { reason: "not a regular file", digest: "n/a" };
      if (st.size > MAX_SCAN_BYTES) {
        return { reason: `too large to scan (${Math.round(st.size / 1024 / 1024)} MiB)`, digest: this.digest(f) };
      }
      const content = readFileSync(abs);
      if (content.includes(0)) return { reason: "binary", digest: sha256(content) };
      return { text: content.toString("utf8") };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      return { reason: `unreadable (${code ?? (e as Error).message})`, digest: "n/a" };
    }
  }

  /** Streamed sha256 of a working-tree file's content (or a marker when it cannot be read). */
  private digest(f: string): string {
    const abs = join(this.cwd, f);
    try {
      if (lstatSync(abs).isSymbolicLink()) return sha256(Buffer.from(`link:${readlinkSync(abs)}`));
      const h = createHash("sha256");
      const fd = openSync(abs, "r");
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let n: number;
        while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
      return h.digest("hex");
    } catch (e) {
      return `unreadable:${(e as NodeJS.ErrnoException).code ?? "error"}`;
    }
  }

  /**
   * Human-readable diff of the working tree against base plus untracked text
   * files. Evidence only (e.g. the patch preserved for an interrupted session);
   * gates use changedFiles()/addedContent().
   */
  workingDiff(base: string): string {
    const parts = [this.exec(["diff", ...PLAIN_DIFF, base])];
    for (const f of this.untrackedFiles()) {
      const r = this.readUntracked(f);
      if (r === null) continue;
      parts.push("text" in r ? `--- untracked: ${f} ---\n${r.text}` : `--- untracked: ${f} (${r.reason}; content omitted) ---`);
    }
    return parts.join("\n");
  }

  /**
   * Create a non-destructive checkpoint commit of the whole working tree
   * (commit policy only). The caller must already have passed the mechanical
   * gate over exactly this tree (git-derived changed files, deny-list, scope),
   * and the commit policy requires a clean checkout at init, so everything
   * staged here is gated feature work. A no-op when nothing changed (e.g. a
   * crash-replayed outcome that was already committed). We never push,
   * rebase, or alter history.
   */
  commitAll(message: string): string {
    this.run(["add", "-A"]);
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: this.cwd, stdio: "ignore" });
      return this.head(); // exit 0: nothing staged
    } catch {
      // exit 1: staged changes to commit
    }
    this.run(["commit", "-q", "-m", message]);
    return this.head();
  }
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * The path in a `diff --git a/P b/P` header. Rename detection is off, so both
 * sides name the same path; that pins the split point even when P contains
 * spaces. Paths with special characters arrive C-quoted.
 */
function diffHeaderPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) return unquoteC(rest).replace(/^a\//, "");
  const len = (rest.length - "a/ b/".length) / 2;
  return rest.slice(2, 2 + len);
}

/** Decode the first C-style quoted string (as git prints unusual paths). */
function unquoteC(s: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') break;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = s[i + 1]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
