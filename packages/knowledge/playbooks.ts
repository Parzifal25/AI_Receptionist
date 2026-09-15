/**
 * Generic playbook mechanism (HALO Phase 1, plan §2.4 rule 1).
 *
 * This module knows NOTHING about any industry. It defines the shape of a
 * "playbook" — behaviour guidance a tenant's agent uses — and a generic
 * matcher/section renderer. The actual playbook DATA is tenant/seed
 * configuration and lives at the application layer (e.g. src/content), or
 * can come from agent configuration, knowledge documents or a database.
 *
 * Shared packages must stay business-agnostic: adding a new industry means
 * adding seed data, never editing this file.
 */

export interface Playbook {
  id: string;
  /** Matched against `${industry} ${description}` lowercased. */
  match: RegExp;
  /** What counts as an emergency and how to respond. Empty = no special emergencies. */
  emergency?: string;
  /** Details worth collecting, in priority order, woven in one at a time. */
  qualifyingDetails: string[];
  /** Domain-specific behaviour notes. */
  notes: string[];
  /** A hard line the assistant must never cross (advice, promises, etc.). */
  compliance?: string;
}

/**
 * Finds the first playbook whose match pattern hits the business's free-text
 * industry/description. Returns null when nothing matches — generic
 * behaviour still applies. Fully data-driven: callers supply the catalog.
 */
export function matchPlaybook(
  playbooks: Playbook[],
  industry: string,
  description = "",
): Playbook | null {
  const haystack = `${industry} ${description}`.toLowerCase();
  if (!haystack.trim()) return null;
  return playbooks.find((p) => p.match.test(haystack)) ?? null;
}

/**
 * Renders a playbook as a system-prompt section. Pure function; the result
 * is appended by the prompt assembler like any other guidance section.
 */
export function renderPlaybookSection(playbook: Playbook): string {
  const lines = [
    ...playbook.notes.map((n) => `- ${n}`),
    `- Useful details to gather naturally over the conversation (one at a time, never as a checklist): ${playbook.qualifyingDetails.join("; ")}.`,
  ];
  if (playbook.compliance) lines.push(`- Hard rule: ${playbook.compliance}`);
  return `## Industry playbook\n${lines.join("\n")}`;
}
