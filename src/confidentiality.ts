/**
 * Confidentiality deny-list matching (Section 7.1).
 *
 * This is a MECHANICAL gate, not a semantic judgment: the controller never
 * infers which names are sensitive. The developer supplies (or confirms) a
 * frozen deny-list of customer/prospect/individual identifiers and
 * customer-specific table/column/schema names. We match that frozen list
 * against added diff content, changed file names, commit messages, and PR text.
 *
 * Matching folds BOTH sides to lowercase letters and digits only (separators,
 * case, and accents erased) and then looks for the folded term as a substring.
 * So the term `trade_events` matches `TRADE_EVENTS`, `trade-events`,
 * `testTradeEventsOoo`, and `test_trade_events_wal`; `AcmeCorp` matches
 * `acme_corp`, `AcmeCorpIngestTest`, and `"acmecorp_trades"`. The list is
 * explicit, so the extra false positives of substring matching (a term inside
 * an unrelated word) are accepted: a pause costs a human glance, a leak does not
 * come back.
 */

export interface DenyMatch {
  term: string;
}

/**
 * Fold text for matching: lowercase letters and digits only. Non-ASCII letters
 * are decomposed and stripped of accents, so `Müller` folds to `muller`.
 */
export function foldForMatch(text: string): string {
  const out: string[] = [];
  let run = 0; // start of the current run of plain ASCII alphanumerics
  const flush = (end: number) => {
    if (end > run) out.push(text.slice(run, end).toLowerCase());
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const asciiAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (asciiAlnum) continue;
    flush(i);
    if (c >= 128) {
      // Slow path, only for non-ASCII code points.
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      if (ch.length === 2) i++;
      const folded = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      for (const f of folded) if (/[\p{L}\p{N}]/u.test(f)) out.push(f);
    }
    run = i + 1;
  }
  flush(text.length);
  return out.join("");
}

/** Deny-list terms that can actually match (a term with no letters or digits folds to ""). */
export function effectiveTerms(denyList: string[]): { term: string; folded: string }[] {
  return denyList.map((term) => ({ term, folded: foldForMatch(term) })).filter((t) => t.folded.length > 0);
}

/** Every deny-list term that occurs anywhere in `text` (each reported once). */
export function scanForDenyTerms(text: string, denyList: string[]): DenyMatch[] {
  const terms = effectiveTerms(denyList);
  if (terms.length === 0 || !text) return [];
  const haystack = foldForMatch(text);
  return terms.filter((t) => haystack.includes(t.folded)).map((t) => ({ term: t.term }));
}
