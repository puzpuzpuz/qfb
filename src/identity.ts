import { createHash } from "node:crypto";
import type { Finding } from "./types.ts";

/**
 * Shared identity-tracking pattern (Sections 2 & 8.2), instantiated over two
 * artifact types: review findings and bug-handoff entries. A blocker that
 * recurs across remediation attempts without its identity being retired counts
 * as "no progress", even if the total finding count drops.
 */

export function findingIdentity(f: Pick<Finding, "id" | "location" | "evidence">): string {
  const norm = `${f.id}\n${f.location}\n${normalizeEvidence(f.evidence)}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function bugIdentity(bug: { id: string; location: string; repro: string }): string {
  const norm = `${bug.id}\n${bug.location}\n${normalizeEvidence(bug.repro)}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

function normalizeEvidence(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Detects no-progress: the same identity surviving across attempts.
 * `history` is the list of identity-sets observed on each prior attempt
 * (most recent last). Returns the identities that have survived at least
 * `limit` consecutive attempts including `current`.
 */
export function detectNoProgress(
  history: string[][],
  current: string[],
  limit: number,
): string[] {
  const window = [...history, current].slice(-limit);
  if (window.length < limit) return [];
  const [first, ...rest] = window;
  const survivors = (first ?? []).filter((id) => rest.every((set) => set.includes(id)));
  return survivors;
}
