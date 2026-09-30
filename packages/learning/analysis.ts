/** Deterministic, transcript-free evidence for a human-authored improvement
 * proposal. This module never edits knowledge, policy or agent versions. */
export interface OutcomeEvidence { disposition: string; escalated: boolean; do_not_call: boolean; }
export function summarizeOutcomes(rows: readonly OutcomeEvidence[]) {
  const dispositions: Record<string, number> = Object.create(null);
  let escalated = 0, suppressed = 0;
  for (const row of rows) {
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
    if (row.escalated) escalated++;
    if (row.do_not_call) suppressed++;
  }
  return { conversations: rows.length, dispositions, escalated, suppressed };
}
