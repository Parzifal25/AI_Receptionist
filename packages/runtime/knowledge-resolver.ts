import type { ChatMessage, KnowledgeSnippet } from "@halo/core/domain/types";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import { buildRetrievalQuery } from "@halo/knowledge/retrieval-query";
import type { KnowledgeContext } from "./contracts";

/**
 * HALO Phase 2 — knowledge resolver (Workstream 6).
 *
 * The runtime-facing retrieval abstraction: prepare the query, retrieve
 * tenant-scoped, filter, bound the count, budget the characters, and keep
 * source labels for citation/telemetry. The existing KnowledgeProvider is
 * reused through an adapter; embeddings and multilingual retrieval are not
 * touched (Phase 3).
 *
 * Known limitations, carried into Phase 3 explicitly:
 *   - `collectionIds` from the agent config are accepted but NOT applied:
 *     the KnowledgeProvider port has no collection parameter yet, so
 *     retrieval remains tenant-wide (today's behaviour).
 *   - Query preparation is the English-centric heuristic in
 *     retrieval-query.ts; multilingual queries are not rewritten.
 * Retrieved text is always treated as data by the composer, never as
 * instructions; nothing here can widen authorization.
 */

export interface KnowledgeResolveParams {
  /** Trusted tenant id. */
  businessId: string;
  /** Persisted agent binding (unused until the port supports collections). */
  collectionIds: string[];
  history: ChatMessage[];
  userMessage: string;
  limits: { maxSnippets: number; maxChars: number };
}

export interface KnowledgeResolver {
  readonly name: string;
  resolve(params: KnowledgeResolveParams): Promise<KnowledgeContext>;
}

export function emptyKnowledge(query = ""): KnowledgeContext {
  return { snippets: [], sources: [], charsUsed: 0, truncated: false, query };
}

/**
 * Applies a character budget to ranked snippets: keeps snippets in rank
 * order, trims the one that crosses the budget, drops the rest. The
 * top-ranked snippet is always kept (trimmed if necessary).
 */
export function budgetSnippets(
  ranked: KnowledgeSnippet[],
  maxSnippets: number,
  maxChars: number,
): { snippets: KnowledgeSnippet[]; charsUsed: number; truncated: boolean } {
  const snippets: KnowledgeSnippet[] = [];
  let charsUsed = 0;
  let truncated = ranked.length > maxSnippets;
  for (const snippet of ranked.slice(0, maxSnippets)) {
    const remaining = maxChars - charsUsed;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (snippet.content.length <= remaining) {
      snippets.push(snippet);
      charsUsed += snippet.content.length;
    } else {
      truncated = true;
      if (snippets.length === 0 || remaining >= 200) {
        snippets.push({ ...snippet, content: snippet.content.slice(0, remaining) });
        charsUsed += remaining;
      }
      break;
    }
  }
  return { snippets, charsUsed, truncated };
}

export class ProviderKnowledgeResolver implements KnowledgeResolver {
  readonly name: string;

  constructor(
    private readonly provider: KnowledgeProvider,
    private readonly options: { minScore?: number } = {},
  ) {
    this.name = `provider:${provider.name}`;
  }

  async resolve(params: KnowledgeResolveParams): Promise<KnowledgeContext> {
    const query = buildRetrievalQuery(params.history, params.userMessage);
    if (!query.trim()) return emptyKnowledge(query);
    const raw = await this.provider.search(params.businessId, query, params.limits.maxSnippets);
    const minScore = this.options.minScore ?? 0;
    const ranked = raw.filter((s) => s.score >= minScore);
    const { snippets, charsUsed, truncated } = budgetSnippets(
      ranked,
      params.limits.maxSnippets,
      params.limits.maxChars,
    );
    return {
      snippets,
      sources: snippets.map((s) => s.title),
      charsUsed,
      truncated,
      query,
    };
  }
}
