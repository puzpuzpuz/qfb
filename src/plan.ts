import type { PlanStep } from "./types.ts";

export interface PlanExtraction {
  steps: PlanStep[];
  /** True when the plan structure was ambiguous and needs explicit approval. */
  ambiguous: boolean;
  notes: string[];
}

/**
 * Extract an ordered implementation plan from a conventional Markdown design
 * document (Section 5). Supports numbered steps, task checkboxes, and headings
 * under an "Implementation Plan" section. Never invents or reorders tasks — it
 * preserves original wording and the document order.
 */
export function extractPlan(markdown: string): PlanExtraction {
  const lines = markdown.split(/\r?\n/);
  const notes: string[] = [];

  // Locate the implementation-plan section if one is explicitly marked.
  let start = 0;
  let end = lines.length;
  const headingRe = /^(#{1,6})\s+(.*)$/;
  let planHeadingLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? "");
    if (m && /implementation\s+plan/i.test(m[2] ?? "")) {
      start = i + 1;
      planHeadingLevel = m[1]!.length;
      // End at the next heading of same or higher level.
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
    notes.push('No explicit "Implementation Plan" heading found; scanned whole document.');
  }

  const region = lines.slice(start, end);
  const rawSteps: string[] = [];

  // Match ordered list items and checkbox items. Nested (indented) items are
  // treated as subtasks of the current top-level step and merged into it.
  const topRe = /^(\d+)[.)]\s+(.*)$/;
  const checkboxRe = /^[-*]\s+\[[ xX]\]\s+(.*)$/;
  const bulletRe = /^[-*]\s+(.*)$/;

  for (const rawLine of region) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const indented = /^\s+/.test(rawLine);

    const topM = topRe.exec(line.trim());
    const cbM = checkboxRe.exec(line.trim());
    const bulletM = bulletRe.exec(line.trim());

    if (!indented && topM) {
      rawSteps.push(topM[2]!.trim());
    } else if (!indented && cbM) {
      rawSteps.push(cbM[1]!.trim());
    } else if (indented && rawSteps.length > 0 && (topM || cbM || bulletM)) {
      // Subtask: append to the current step's wording.
      const subText = (topM?.[2] ?? cbM?.[1] ?? bulletM?.[1] ?? "").trim();
      rawSteps[rawSteps.length - 1] += `\n  - ${subText}`;
    }
  }

  const ambiguous = rawSteps.length === 0;
  if (ambiguous) {
    notes.push(
      "Could not extract any ordered steps. A proposed mapping must be supplied and approved before execution.",
    );
  }

  const steps: PlanStep[] = rawSteps.map((text, idx) => ({
    id: `S${idx + 1}`,
    ordinal: idx + 1,
    text,
    status: "pending",
  }));

  return { steps, ambiguous, notes };
}
