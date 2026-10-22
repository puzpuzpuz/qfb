import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanForDenyTerms } from "./confidentiality.ts";
import { parseReviewReport } from "./report.ts";
import type { GitLike, AcceptedCandidate, AcceptedReview } from "./controller.ts";

export interface PrResult {
  opened: boolean;
  /** The accepted commit was pushed (to a new or an already-open PR). */
  pushed: boolean;
  url?: string;
  reason: string;
}

export interface PrRequest {
  branch: string;
  prBase: string;
  /** Feature base the accepted fingerprint was computed against. */
  featureBase: string;
  title: string;
  body: string;
  /** The candidate the final review accepted; nothing else may be pushed. */
  accepted: AcceptedCandidate | null;
  checkpointPolicy: "snapshot" | "commit";
  denyList: string[];
}

/**
 * Why the checkout must not be pushed, or null when HEAD is exactly the
 * reviewed, verified candidate on the run's branch with nothing uncommitted.
 */
export function pushBlocker(git: Pick<GitLike, "branch" | "head" | "isClean" | "snapshot">, req: PrRequest): string | null {
  if (req.checkpointPolicy !== "commit") {
    return "the run uses snapshot checkpoints, so the verified changes are uncommitted and there is nothing safe to push; commit them yourself, or start a new run with --commit";
  }
  const a = req.accepted;
  if (!a) return "no accepted candidate is recorded for this run";
  const branch = git.branch();
  if (branch !== req.branch || a.branch !== req.branch) {
    return `the checkout is on '${branch}', not the verified branch '${req.branch}'`;
  }
  if (!git.isClean()) return "the working tree has uncommitted or untracked changes, so HEAD is not the reviewed candidate";
  const head = git.head();
  if (head !== a.head) return `HEAD ${head.slice(0, 12)} is not the reviewed commit ${a.head.slice(0, 12)}`;
  if (git.snapshot(req.featureBase).dirtyFingerprint !== a.fingerprint) {
    return "the tree no longer matches the reviewed candidate";
  }
  return null;
}

/**
 * Push the accepted commit and open a pull request for the feature branch if
 * one is not already open. An already-open PR still receives the push, so it
 * never lags behind the commit the final review accepted.
 *
 * NOTE: spec Section 7 defaults QFB to never push or open PRs without separate
 * authorization. Invoking `qfb build` IS that explicit authorization for the
 * final, completed candidate only: this runs only after COMPLETED, pushes only
 * the exact commit the final review accepted (never forced), and refuses
 * deny-listed PR text.
 */
export function openPrIfNone(repoPath: string, git: Pick<GitLike, "branch" | "head" | "isClean" | "snapshot">, req: PrRequest): PrResult {
  const leaks = scanForDenyTerms(`${req.title}\n${req.body}`, req.denyList);
  if (leaks.length > 0) {
    return {
      opened: false,
      pushed: false,
      reason: `PR title/body contains deny-listed term(s) ${leaks.map((m) => `"${m.term}"`).join(", ")}; pass a neutral --pr-title`,
    };
  }
  const blocker = pushBlocker(git, req);
  if (blocker) return { opened: false, pushed: false, reason: `not pushing: ${blocker}` };

  const gh = (args: string[]): string =>
    execFileSync("gh", args, { cwd: repoPath, encoding: "utf8" });
  const firstLine = (e: unknown) => (e as Error).message.split("\n")[0];

  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return { opened: false, pushed: false, reason: "gh CLI not found; skipped PR creation. Push and open the PR manually." };
  }

  // Push the verified branch first: a new PR needs it, and an open one must not go stale.
  try {
    execFileSync("git", ["push", "-u", "origin", req.branch], { cwd: repoPath, stdio: "inherit" });
  } catch (e) {
    return { opened: false, pushed: false, reason: `git push failed: ${firstLine(e)}` };
  }

  try {
    const existing = gh(["pr", "list", "--head", req.branch, "--state", "open", "--json", "url"]);
    const arr = JSON.parse(existing || "[]") as { url: string }[];
    if (arr.length > 0) {
      return { opened: false, pushed: true, url: arr[0]!.url, reason: "pushed the accepted commit to the already-open PR" };
    }
  } catch (e) {
    return { opened: false, pushed: true, reason: `pushed, but could not query existing PRs: ${firstLine(e)}` };
  }

  try {
    const out = gh(["pr", "create", "--base", req.prBase, "--head", req.branch, "--title", req.title, "--body", req.body]);
    const url = out.trim().split("\n").filter(Boolean).pop() ?? "";
    return { opened: true, pushed: true, url, reason: "opened a new PR" };
  } catch (e) {
    return { opened: false, pushed: true, reason: `pushed, but gh pr create failed: ${firstLine(e)}` };
  }
}

/** GitHub rejects comments over 65,536 characters; keep clear of it. */
const MAX_COMMENT = 60_000;

/**
 * The PR comment for the approving review: a header naming the run and the
 * reviewed commit, then the report itself, without its qfb-review block (the
 * machine-readable copy of what the report already says).
 */
export function reviewCommentBody(runId: string, review: AcceptedReview, raw: string): string {
  let label = "approve";
  try {
    label = parseReviewReport(raw).verdictLabel;
  } catch {
    // The report was parsed when the review was accepted; keep the generic label.
  }
  const header =
    `### QFB review: ${label}\n\n` +
    `Final review (iteration ${review.iteration}) of \`${review.head.slice(0, 12)}\` by QFB run \`${runId}\`.\n\n---\n\n`;
  let report = raw.replace(/```qfb-review[ \t]*\r?\n[\s\S]*?```[ \t]*\r?\n?/g, "").trim();
  const room = MAX_COMMENT - header.length;
  if (report.length > room) {
    const note = `\n\n_(Truncated; the full report is in QFB's artifacts for run \`${runId}\`.)_`;
    report = report.slice(0, room - note.length) + note;
  }
  return header + report + "\n";
}

export interface ReviewPostResult {
  posted: boolean;
  /** Trying again later may succeed (it cannot when the report has a deny-listed term). */
  retryable: boolean;
  reason: string;
}

/**
 * Post the approving review on the PR as a comment. Like the PR text, the
 * comment is refused when it contains a deny-listed term.
 */
export function postReviewComment(repoPath: string, prUrl: string, runId: string, review: AcceptedReview, denyList: string[]): ReviewPostResult {
  let raw: string;
  try {
    raw = readFileSync(review.reportPath, "utf8");
  } catch (e) {
    return { posted: false, retryable: true, reason: `cannot read the review report ${review.reportPath}: ${(e as Error).message}` };
  }
  const body = reviewCommentBody(runId, review, raw);
  const leaks = scanForDenyTerms(body, denyList);
  if (leaks.length > 0) {
    return {
      posted: false,
      retryable: false,
      reason: `the review report contains deny-listed term(s) ${leaks.map((m) => `"${m.term}"`).join(", ")}; not posted (report: ${review.reportPath})`,
    };
  }
  try {
    execFileSync("gh", ["pr", "comment", prUrl, "--body-file", "-"], { cwd: repoPath, input: body, stdio: ["pipe", "ignore", "pipe"] });
  } catch (e) {
    return { posted: false, retryable: true, reason: `gh pr comment failed: ${(e as Error).message.split("\n")[0]}` };
  }
  return { posted: true, retryable: false, reason: "posted the approving review on the PR" };
}
