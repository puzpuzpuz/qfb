import { execFileSync } from "node:child_process";
import { scanForDenyTerms } from "./confidentiality.ts";
import type { GitLike, AcceptedCandidate } from "./controller.ts";

export interface PrResult {
  opened: boolean;
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
 * Open a pull request for the feature branch if one is not already open.
 *
 * NOTE: spec Section 7 defaults QFB to never push or open PRs without separate
 * authorization. Invoking `qfb build` IS that explicit authorization for the
 * final, completed candidate only: this runs only after COMPLETED, pushes only
 * the exact commit the final review accepted, and refuses deny-listed PR text.
 */
export function openPrIfNone(repoPath: string, git: Pick<GitLike, "branch" | "head" | "isClean" | "snapshot">, req: PrRequest): PrResult {
  const leaks = scanForDenyTerms(`${req.title}\n${req.body}`, req.denyList);
  if (leaks.length > 0) {
    return {
      opened: false,
      reason: `PR title/body contains deny-listed term(s) ${leaks.map((m) => `"${m.term}"`).join(", ")}; pass a neutral --pr-title`,
    };
  }
  const blocker = pushBlocker(git, req);
  if (blocker) return { opened: false, reason: `not pushing: ${blocker}` };

  const gh = (args: string[]): string =>
    execFileSync("gh", args, { cwd: repoPath, encoding: "utf8" });

  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return { opened: false, reason: "gh CLI not found; skipped PR creation. Push and open the PR manually." };
  }

  // Already an open PR for this branch?
  try {
    const existing = gh(["pr", "list", "--head", req.branch, "--state", "open", "--json", "url"]);
    const arr = JSON.parse(existing || "[]") as { url: string }[];
    if (arr.length > 0) {
      return { opened: false, url: arr[0]!.url, reason: "an open PR already exists for this branch" };
    }
  } catch (e) {
    return { opened: false, reason: `could not query existing PRs: ${(e as Error).message.split("\n")[0]}` };
  }

  // Push the verified branch, then open the PR.
  try {
    execFileSync("git", ["push", "-u", "origin", req.branch], { cwd: repoPath, stdio: "inherit" });
  } catch (e) {
    return { opened: false, reason: `git push failed: ${(e as Error).message.split("\n")[0]}` };
  }

  try {
    const out = gh(["pr", "create", "--base", req.prBase, "--head", req.branch, "--title", req.title, "--body", req.body]);
    const url = out.trim().split("\n").filter(Boolean).pop() ?? "";
    return { opened: true, url, reason: "opened a new PR" };
  } catch (e) {
    return { opened: false, reason: `gh pr create failed: ${(e as Error).message.split("\n")[0]}` };
  }
}
