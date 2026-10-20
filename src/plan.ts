import type { PlanStep } from "./types.ts";

export interface PlanExtraction {
  steps: PlanStep[];
  /**
   * True when the plan structure is ambiguous: no steps at all, or a proposed
   * mapping that a human must confirm explicitly (several lists, numbering
   * restarts, mixed list kinds). `notes` say why.
   */
  ambiguous: boolean;
  notes: string[];
  /** How the steps were delimited, for transparency in the prepared manifest. */
  strategy: "heading" | "ordered-list" | "checkbox" | "mixed-list" | "none";
  /** Canonical, normalized plan markdown (produced by the preparation phase). */
  normalizedMarkdown: string;
}

/** One source line, tagged with whether it sits inside a fenced code block. */
interface Line {
  text: string;
  /** Inside a ``` / ~~~ fence, including the fence lines themselves. */
  code: boolean;
  /** For code lines: the indentation of the opening fence line. */
  fenceIndent: number;
}

// ATX headings may be indented up to three spaces; deeper indentation is code.
const headingRe = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const stepHeadingRe = /^step\s+(\d+)\b/i;
const orderedRe = /^(\d+)[.)]([ \t]+|$)/;
const checkboxRe = /^[-*+][ \t]+\[[ xX]\]([ \t]+|$)/;
const fenceRe = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Extract an ordered implementation plan from a conventional Markdown design or
 * handoff document (Section 5).
 *
 * Supported step shapes, in priority order:
 *   1. Sub-headings like `### Step 0 — ...` / `## Step 1: ...` (heading-delimited).
 *   2. Numbered list items (`1.`, `2)`).
 *   3. Task checkboxes (`- [ ]`, `- [x]`).
 *
 * Fenced code blocks are opaque: a `# comment` in a bash snippet is not a
 * heading and a `1.` inside one is not a step. Each step keeps its full body
 * (continuation lines, nested lists, code). The extractor never invents or
 * reorders tasks; when the structure admits more than one reading it still
 * proposes the mapping but flags it as ambiguous for explicit approval.
 */
export function extractPlan(markdown: string): PlanExtraction {
  const lines = tagFences(markdown.split(/\r?\n/));
  const notes: string[] = [];

  // Locate the implementation-plan section if one is explicitly marked.
  let start = 0;
  let end = lines.length;
  let planHeadingLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = heading(lines[i]!);
    if (h && /implementation\s+plan/i.test(h.title)) {
      start = i + 1;
      planHeadingLevel = h.level;
      for (let j = i + 1; j < lines.length; j++) {
        const h2 = heading(lines[j]!);
        if (h2 && h2.level <= planHeadingLevel) {
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
  const byHeading = extractHeadingSteps(region, planHeadingLevel);
  if (byHeading.steps.length > 0) {
    return finalize(byHeading.steps, "heading", notes, byHeading.problems);
  }

  // --- Strategy 2/3: ordered list items / checkboxes ---
  const byList = extractListItems(region);
  if (byList.steps.length > 0) {
    return finalize(byList.steps, byList.strategy, notes, byList.problems);
  }

  notes.push(
    "Could not extract any ordered steps (no step headings, numbered list, or checkboxes). " +
      "Edit the design so its plan uses one of these shapes before approving.",
  );
  return { steps: [], ambiguous: true, notes, strategy: "none", normalizedMarkdown: renderManifest([], notes) };
}

/** Mark the lines that belong to fenced code blocks (CommonMark fence rules, any indentation). */
function tagFences(raw: string[]): Line[] {
  let open: { ch: string; len: number; indent: number } | null = null;
  return raw.map((text) => {
    const m = fenceRe.exec(text);
    if (!open) {
      if (m && !(m[1]![0] === "`" && text.slice(m[0].length).includes("`"))) {
        open = { ch: m[1]![0]!, len: m[1]!.length, indent: m[0].length - m[1]!.length };
        return { text, code: true, fenceIndent: open.indent };
      }
      return { text, code: false, fenceIndent: 0 };
    }
    const indent = open.indent;
    if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && text.slice(m[0].length).trim() === "") {
      open = null;
    }
    return { text, code: true, fenceIndent: indent };
  });
}

function heading(l: Line): { level: number; title: string } | null {
  if (l.code) return null;
  const m = headingRe.exec(l.text);
  return m ? { level: m[1]!.length, title: m[2]!.trim() } : null;
}

/** Collect `Step N` sub-headings and the body beneath each as a step. */
function extractHeadingSteps(region: Line[], planLevel: number): { steps: string[]; problems: string[] } {
  // The heading level used for steps: the first "Step N" sub-heading deeper than the plan heading.
  let stepLevel = -1;
  for (const l of region) {
    const h = heading(l);
    if (h && (planLevel === -1 || h.level > planLevel) && stepHeadingRe.test(h.title)) {
      stepLevel = h.level;
      break;
    }
  }
  if (stepLevel === -1) return { steps: [], problems: [] };

  const steps: string[] = [];
  const numbers: number[] = [];
  let current: string[] | null = null;
  for (const l of region) {
    const h = heading(l);
    if (h) {
      const m = stepHeadingRe.exec(h.title);
      if (h.level === stepLevel && m) {
        if (current) steps.push(trimBlock(current));
        current = [h.title];
        numbers.push(Number(m[1]));
        continue;
      }
      // A heading at or above the step level that is NOT a step ends the step body.
      if (h.level <= stepLevel) {
        if (current) steps.push(trimBlock(current));
        current = null;
        continue;
      }
    }
    if (current) current.push(l.text.replace(/\s+$/, ""));
  }
  if (current) steps.push(trimBlock(current));
  return { steps, problems: numberingProblems(numbers, "Step heading") };
}

type ListKind = "ordered" | "checkbox";

/**
 * Collect top-level numbered items / checkboxes with their full bodies. An item
 * runs until the next top-level item, a heading, or (after a blank line) an
 * unindented paragraph, which also ends the list. Fenced code right under an
 * item belongs to it even when unindented, as authors commonly write it.
 */
function extractListItems(region: Line[]): {
  steps: string[];
  strategy: "ordered-list" | "checkbox" | "mixed-list";
  problems: string[];
} {
  const items: { kind: ListKind; number: number | null; list: number; lines: string[]; indent: number }[] = [];
  let current: (typeof items)[number] | null = null;
  let lists = 0;
  let listOpen = false;
  let blank = false;

  for (const l of region) {
    if (l.code) {
      if (current) current.lines.push(dedent(l.text, Math.min(current.indent, l.fenceIndent)));
      blank = false;
      continue;
    }
    if (heading(l)) {
      current = null;
      listOpen = false;
      blank = false;
      continue;
    }
    const text = l.text.replace(/\s+$/, "");
    if (text === "") {
      if (current) current.lines.push("");
      blank = true;
      continue;
    }
    const indented = /^[ \t]/.test(text);
    const ordered = indented ? null : orderedRe.exec(text);
    const checkbox = indented ? null : checkboxRe.exec(text);
    if (ordered || checkbox) {
      if (!listOpen) {
        lists++;
        listOpen = true;
      }
      const marker = (ordered ?? checkbox)![0];
      current = {
        kind: ordered ? "ordered" : "checkbox",
        number: ordered ? Number(ordered[1]) : null,
        list: lists,
        lines: [text.slice(marker.length).trim()],
        indent: ordered ? marker.length : 2,
      };
      items.push(current);
    } else if (current && (indented || !blank)) {
      // Indented continuation, or a lazy continuation line right under the item.
      current.lines.push(dedent(text, current.indent));
    } else {
      // An unindented paragraph after a blank line: the list (and its last item) ended.
      current = null;
      listOpen = false;
    }
    blank = false;
  }

  const steps = items.map((i) => trimBlock(i.lines));
  const kinds = new Set(items.map((i) => i.kind));
  const strategy = kinds.size > 1 ? "mixed-list" : kinds.has("checkbox") ? "checkbox" : "ordered-list";
  const problems: string[] = [];
  if (kinds.size > 1) problems.push("The plan mixes numbered items and checkboxes; QFB merged them in document order.");

  // Separate lists are one plan only when a later numbered list continues the numbering.
  const separate: number[] = [];
  for (let n = 2; n <= lists; n++) {
    const prev = items.filter((i) => i.list === n - 1).pop()!;
    const first = items.find((i) => i.list === n)!;
    const continues = prev.number !== null && first.number !== null && first.number === prev.number + 1;
    if (!continues) separate.push(n);
  }
  if (separate.length > 0) {
    problems.push(
      `The plan region contains ${separate.length + 1} separate lists (e.g. an "Acceptance criteria" list after the steps); ` +
        "QFB treated every item as a step.",
    );
  }
  for (const n of new Set(items.map((i) => i.list))) {
    const nums = items.filter((i) => i.list === n && i.number !== null).map((i) => i.number!);
    problems.push(...numberingProblems(nums, "List item"));
  }
  return { steps, strategy, problems: [...new Set(problems)] };
}

/** Restarts and repeats in step numbering ("1. 1. 1." lazy numbering is fine). */
function numberingProblems(nums: number[], what: string): string[] {
  if (nums.length > 1 && nums.every((n) => n === nums[0])) return [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! <= nums[i - 1]!) {
      return [`${what} numbering restarts or repeats (${nums[i - 1]} then ${nums[i]}); two plans may have been merged.`];
    }
  }
  return [];
}

/** Remove up to `n` columns of leading indentation (the list item's content offset). */
function dedent(s: string, n: number): string {
  let i = 0;
  while (i < n && i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return s.slice(i).replace(/\s+$/, "");
}

/** Join lines, dropping leading/trailing blank lines but keeping interior layout verbatim. */
function trimBlock(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a++;
  while (b > a && lines[b - 1]!.trim() === "") b--;
  return lines.slice(a, b).join("\n");
}

function finalize(
  rawSteps: string[],
  strategy: PlanExtraction["strategy"],
  notes: string[],
  problems: string[],
): PlanExtraction {
  const steps: PlanStep[] = rawSteps.map((text, idx) => ({
    id: `S${idx + 1}`,
    ordinal: idx + 1,
    text,
    status: "pending",
  }));
  notes.push(`Extracted ${steps.length} step(s) using the "${strategy}" strategy.`);
  for (const p of problems) notes.push(`AMBIGUOUS: ${p}`);
  return {
    steps,
    ambiguous: problems.length > 0,
    notes,
    strategy,
    normalizedMarkdown: renderManifest(steps, notes),
  };
}

/**
 * Produce QFB's canonical normalized plan manifest. This is the artifact the
 * preparation phase shows for approval. It preserves the original wording of
 * each step verbatim; it never rewrites or reorders content.
 */
export function renderManifest(steps: Pick<PlanStep, "id" | "text">[], notes: string[]): string {
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
    out.push("_No steps could be extracted. Edit the design document; `qfb approve` re-extracts it._");
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
