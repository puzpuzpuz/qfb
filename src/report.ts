import { Verdict, Severity } from "./types.ts";
import type { ReviewReport, Finding, VerdictName, SeverityName } from "./types.ts";

export class AmbiguousReportError extends Error {}

/**
 * Parse review-pr's structured report surface (Section 8.1).
 *
 * The orchestrator requires a stable, machine-readable surface. We support a
 * fenced ```qfb-review JSON block (the documented structured-output contract).
 * If the block is absent or the verdict/finding boundaries cannot be identified
 * with confidence, we PAUSE by throwing AmbiguousReportError rather than
 * guessing boundaries with heuristics. Exactly one block is accepted: with two
 * (e.g. a quoted example plus the real one) we cannot tell which is the verdict.
 */
export function parseReviewReport(raw: string): ReviewReport {
  const blocks = extractBlocks(raw, "qfb-review");
  if (blocks.length === 0) {
    throw new AmbiguousReportError(
      "No machine-readable qfb-review block found; cannot determine verdict or finding boundaries.",
    );
  }
  if (blocks.length > 1) {
    throw new AmbiguousReportError(
      `Found ${blocks.length} qfb-review blocks; exactly one is required to know which holds the verdict.`,
    );
  }
  const block = blocks[0]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new AmbiguousReportError(`qfb-review block is not valid JSON: ${(e as Error).message}`);
  }

  const obj = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(obj.verdict);
  if (!verdict) {
    throw new AmbiguousReportError(`Unrecognized verdict: ${JSON.stringify(obj.verdict)}`);
  }

  if (typeof obj.testGatePassed !== "boolean") {
    throw new AmbiguousReportError("Report is missing a boolean testGatePassed field.");
  }

  const findings = parseFindings(obj.findings);

  return { verdict, findings, testGatePassed: obj.testGatePassed, raw };
}

function parseFindings(value: unknown): Finding[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AmbiguousReportError("findings must be an array.");
  }
  const seen = new Set<string>();
  return value.map((f, i) => {
    const o = f as Record<string, unknown>;
    const severity = normalizeSeverity(o.severity);
    if (typeof o.id !== "string" || !o.id) {
      throw new AmbiguousReportError(`finding[${i}] has no stable id.`);
    }
    if (seen.has(o.id)) {
      throw new AmbiguousReportError(`finding id ${JSON.stringify(o.id)} appears more than once; finding boundaries are unclear.`);
    }
    seen.add(o.id);
    if (!severity) {
      throw new AmbiguousReportError(`finding[${i}] has unrecognized severity: ${JSON.stringify(o.severity)}`);
    }
    return {
      id: o.id,
      severity,
      location: typeof o.location === "string" ? o.location : "",
      evidence: typeof o.evidence === "string" ? o.evidence : "",
    };
  });
}

function extractBlocks(raw: string, tag: string): string[] {
  const re = new RegExp("```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");
  return [...raw.matchAll(re)].map((m) => m[1]!.trim());
}

function normalizeVerdict(v: unknown): VerdictName | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (["approved", "approve", "pass", "clean"].includes(s)) return Verdict.APPROVED;
  if (["blocking", "blocked", "changes-requested", "reject"].includes(s)) return Verdict.BLOCKING;
  if (["needs-discussion", "needs discussion", "discuss", "needs_decision"].includes(s)) {
    return Verdict.NEEDS_DISCUSSION;
  }
  return null;
}

function normalizeSeverity(v: unknown): SeverityName | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "critical") return Severity.CRITICAL;
  if (s === "moderate" || s === "major") return Severity.MODERATE;
  if (s === "minor" || s === "low") return Severity.MINOR;
  if (s === "adjacent") return Severity.ADJACENT;
  return null;
}

/**
 * Select actionable findings for fix-pr per the acceptance policy (Section 8).
 * Default: admitted Critical only. Strict: Critical + Moderate + Minor.
 * Adjacent findings are never automatically authorized.
 */
export function selectActionableFindings(report: ReviewReport, strict: boolean): Finding[] {
  return report.findings.filter((f) => {
    if (f.severity === Severity.ADJACENT) return false;
    if (f.severity === Severity.CRITICAL) return true;
    return strict && (f.severity === Severity.MODERATE || f.severity === Severity.MINOR);
  });
}

/** Default acceptance: no admitted Critical findings and a passing test gate. */
export function isAcceptable(report: ReviewReport, strict: boolean): boolean {
  if (!report.testGatePassed) return false;
  if (report.verdict === Verdict.NEEDS_DISCUSSION) return false;
  const actionable = selectActionableFindings(report, strict);
  return actionable.length === 0 && report.verdict !== Verdict.BLOCKING;
}
