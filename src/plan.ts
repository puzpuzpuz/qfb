import type { PlanStep } from "./types.ts";

export interface PlanExtraction {
  steps: PlanStep[];
  /** True when the plan structure was ambiguous and needs explicit approval. */
  ambiguous: boolean;
  notes: string[];
  /** How the steps were delimited, for transparency in the prepared manifest. */
  strategy: "heading" | "ordered-list" | "checkbox" | "none";
  /** Canonical, normalized plan markdown (produced by the preparation phase). */
  normalizedMarkdown: string;
}

const headingRe = /^(#{1,6})\s+(.*)$/;
const stepHeadingRe = /^step\s+\d+\b/i;
const topRe = /^(\d+)[.)]\s+(.*)$/;
const checkboxRe = /^[-*]\s+\[[ xX]\]\s+(.*)$/;
const bulletRe = /^[-*]\s+(.*)$/;

/**
 * Extract an ordered implementation plan from a conventional Markdown design or
 * handoff document (Section 5).
 *
 * Supported step shapes, in priority order:
 *   1. Sub-headings like `### Step 0 — ...` / `## Step 1: ...` (heading-delimited).
 *   2. Numbered list items (`1.`, `2)`).
 *   3. Task checkboxes (`- [ ]`, `- [x]`).
 *
 * The extractor never invents or reorders tasks — it preserves the original
 * wording and the document order, and flags ambiguity for approval.
 */
export function extractPlan(markdown: string): PlanExtraction {
  const lines = markdown.split(/\r?\n/);
  const notes: string[] = [];

  // Locate the implementation-plan section if one is explicitly marked.
  let start = 0;
  let end = lines.length;
  let planHeadingLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? "");
    if (m && /implementation\s+plan/i.test(m[2] ?? "")) {
      start = i + 1;
      planHeadingLevel = m[1]!.length;
      for (let j = i + 1; j < lines.length; j++) {
        const m2 = headingRe.exec(lines[j] ?? "");
        if (m2 && m2[1]!.length <= planHeadingLevel) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (planHeadingLevel === -1) {
    notes.push('No explicit "Implementation Plan" heading found; scanned the whole document.');
  }

  const region = lines.slice(start, end);

  // --- Strategy 1: heading-delimited steps (e.g. "### Step N — ...") ---
  const headingSteps = extractHeadingSteps(region, planHeadingLevel);
  if (headingSteps.length > 0) {
    return finalize(headingSteps, "heading", notes, markdown);
  }

  // --- Strategy 2/3: ordered list items / checkboxes (with merged subtasks) ---
  const { items, strategy } = extractListItems(region);
  if (items.length > 0) {
    return finalize(items, strategy, notes, markdown);
  }

  notes.push(
    "Could not extract any ordered steps (no step headings, numbered list, or checkboxes). " +
      "A proposed mapping must be supplied and approved before execution.",
  );
  return {
    steps: [],
    ambiguous: true,
    notes,
    strategy: "none",
    normalizedMarkdown: normalize([], markdown, notes),
  };
}

/** Collect `Step N` sub-headings and the body beneath each as a step. */
function extractHeadingSteps(region: string[], planLevel: number): string[] {
  // Determine the heading level used for steps: the first sub-heading matching
  // "Step N" deeper than the plan heading.
  let stepLevel = -1;
  for (const raw of region) {
    const m = headingRe.exec(raw.trim());
    if (m && (planLevel === -1 || m[1]!.length > planLevel) && stepHeadingRe.test(m[2]!.trim())) {
      stepLevel = m[1]!.length;
      break;
    }
  }
  if (stepLevel === -1) return [];

  const steps: string[] = [];
  let current: string[] | null = null;
  for (const raw of region) {
    const m = headingRe.exec(raw.trim());
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      if (level === stepLevel && stepHeadingRe.test(title)) {
        if (current) steps.push(current.join("\n").trim());
        current = [title];
        continue;
      }
      // A heading at or above the step level that is NOT a step ends the plan body.
      if (level <= stepLevel) {
        if (current) {
          steps.push(current.join("\n").trim());
          current = null;
        }
        continue;
      }
    }
    if (current) current.push(raw.replace(/\s+$/, ""));
  }
  if (current) steps.push(current.join("\n").trim());
  return steps.filter((s) => s.length > 0);
}

/** Collect numbered list items / checkboxes; indented items merge as subtasks. */
function extractListItems(region: string[]): { items: string[]; strategy: "ordered-list" | "checkbox" } {
  const items: string[] = [];
  let strategy: "ordered-list" | "checkbox" = "ordered-list";
  for (const rawLine of region) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const indented = /^\s+/.test(rawLine);
    const t = line.trim();
    const topM = topRe.exec(t);
    const cbM = checkboxRe.exec(t);
    const bulletM = bulletRe.exec(t);

    if (!indented && topM) {
      items.push(topM[2]!.trim());
    } else if (!indented && cbM) {
      strategy = "checkbox";
      items.push(cbM[1]!.trim());
    } else if (indented && items.length > 0 && (topM || cbM || bulletM)) {
      const subText = (topM?.[2] ?? cbM?.[1] ?? bulletM?.[1] ?? "").trim();
      items[items.length - 1] += `\n  - ${subText}`;
    }
  }
  return { items, strategy };
}

function finalize(
  rawSteps: string[],
  strategy: PlanExtraction["strategy"],
  notes: string[],
  original: string,
): PlanExtraction {
  const steps: PlanStep[] = rawSteps.map((text, idx) => ({
    id: `S${idx + 1}`,
    ordinal: idx + 1,
    text,
    status: "pending",
  }));
  notes.push(`Extracted ${steps.length} step(s) using the "${strategy}" strategy.`);
  return {
    steps,
    ambiguous: false,
    notes,
    strategy,
    normalizedMarkdown: normalize(steps, original, notes),
  };
}

/**
 * Produce QFB's canonical normalized plan manifest. This is the artifact the
 * preparation phase shows for approval. It preserves the original wording of
 * each step verbatim; it never rewrites or reorders content.
 */
function normalize(steps: PlanStep[], _original: string, notes: string[]): string {
  const out: string[] = [];
  out.push("# QFB Prepared Plan (normalized manifest)");
  out.push("");
  out.push(
    "> Auto-normalized by QFB's preparation phase from the approved design/handoff document.",
  );
  out.push("> Original wording is preserved verbatim; order is unchanged. Review and approve this");
  out.push("> mapping before execution. This file lives only in QFB's artifact store.");
  out.push("");
  for (const n of notes) out.push(`> note: ${n}`);
  out.push("");
  if (steps.length === 0) {
    out.push("_No steps could be extracted. Adjust the design document and re-run `qfb init`._");
    return out.join("\n") + "\n";
  }
  for (const s of steps) {
    out.push(`## ${s.id}`);
    out.push("");
    for (const line of s.text.split("\n")) out.push(line);
    out.push("");
  }
  return out.join("\n") + "\n";
}
