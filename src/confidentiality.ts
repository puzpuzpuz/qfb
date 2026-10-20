/**
 * Confidentiality deny-list matching (Section 7.1).
 *
 * This is a MECHANICAL gate, not a semantic judgment: the controller never
 * infers which names are sensitive. The developer supplies (or confirms) a
 * frozen deny-list of customer/prospect/individual identifiers and
 * customer-specific table/column/schema names. We match that frozen list
 * case-insensitively, including common token variants, against staged diffs,
 * changed files, and commit messages.
 */

export interface DenyMatch {
  term: string;
  context: string;
  snippet: string;
}

function tokenVariants(term: string): string[] {
  const base = term.trim();
  if (!base) return [];
  const variants = new Set<string>();
  const lower = base.toLowerCase();
  variants.add(lower);
  // snake_case / kebab-case / camelCase / nospace variants of multi-word terms.
  const words = lower.split(/[\s_\-]+/).filter(Boolean);
  if (words.length > 1) {
    variants.add(words.join("_"));
    variants.add(words.join("-"));
    variants.add(words.join(""));
    variants.add(words[0] + words.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""));
  }
  return [...variants];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan text for any deny-list term (or token variant). Matching is bounded by
 * word boundaries where the variant is alphanumeric to avoid matching inside
 * unrelated identifiers, but substring-contains for terms containing separators.
 */
export function scanForDenyTerms(text: string, denyList: string[]): DenyMatch[] {
  const matches: DenyMatch[] = [];
  const haystack = text.toLowerCase();
  for (const term of denyList) {
    for (const variant of tokenVariants(term)) {
      if (!variant) continue;
      const re = new RegExp(`\\b${escapeRe(variant)}\\b`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack)) !== null) {
        const idx = m.index;
        const snippet = text.slice(Math.max(0, idx - 30), idx + variant.length + 30);
        matches.push({ term, context: "match", snippet: snippet.trim() });
        break; // one match per variant is enough to fail the gate
      }
    }
  }
  return matches;
}
