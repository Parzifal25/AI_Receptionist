import type { OrderedVoicePersistence } from "./ordered-persistence";
import type { ChatMessage } from "@halo/core/domain/types";
import type { ConversationState, ConversationStateStore } from "@halo/runtime/conversation-state";
import type { ConversationStore, ToolTranscriptRecord } from "@halo/runtime/system-actions";

/** W4.4: one active call's successful state/history, never knowledge or policy.
 * Default writes are awaited and failures invalidate the cache. An explicit
 * voice queue instead keeps accepted local state/history; completion then means
 * queue admission only, never proof of database durability.
 */
export class CallContextCache implements ConversationStore, ConversationStateStore {
  private history: ChatMessage[] | null = null;
  private state: ConversationState | null | undefined;
  private stateRevision = 0;

  constructor(
    private readonly tenant: string,
    private readonly conversation: string,
    private readonly conversations: ConversationStore,
    private readonly states: ConversationStateStore,
    private readonly maxHistory: number,
    private readonly queue?: OrderedVoicePersistence,
  ) {
    if (!Number.isInteger(maxHistory) || maxHistory <= 0) throw new Error("Invalid voice history capacity");
  }

  private scope(conversationId: string, businessId: string): void {
    if (conversationId !== this.conversation || businessId !== this.tenant) throw new Error("Voice context scope mismatch");
  }

  async loadHistory(conversationId: string, businessId: string, limit: number): Promise<ChatMessage[]> {
    this.scope(conversationId, businessId);
    if (this.history === null || limit > this.maxHistory) {
      const rows = await this.conversations.loadHistory(conversationId, businessId, limit);
      this.history = structuredClone(rows.slice(-this.maxHistory));
      return structuredClone(rows);
    }
    return structuredClone(this.history.slice(-limit));
  }

  async appendMessages(conversationId: string, businessId: string, messages: ChatMessage[]): Promise<void> {
    this.scope(conversationId, businessId);
    const copy = structuredClone(messages);
    if (this.queue) {
      // Keep the caller's actual context even when persistence is unavailable.
      // The queue exposes failure/pending status; it never certifies delivery.
      if (this.history !== null) this.history = structuredClone([...this.history, ...copy].slice(-this.maxHistory));
      this.queue.enqueue("messages", () => this.conversations.appendMessages(conversationId, businessId, copy));
      return;
    }
    try {
      await this.conversations.appendMessages(conversationId, businessId, copy);
      if (this.history !== null) this.history = structuredClone([...this.history, ...copy].slice(-this.maxHistory));
    } catch (error) {
      this.history = null;
      throw error;
    }
  }

  async appendToolRecords(conversationId: string, businessId: string, records: ToolTranscriptRecord[]): Promise<void> {
    this.scope(conversationId, businessId);
    if (!this.conversations.appendToolRecords) return;
    const copy = structuredClone(records);
    if (this.queue) {
      this.queue.enqueue("tool_history", () => this.conversations.appendToolRecords!(conversationId, businessId, copy));
      return;
    }
    await this.conversations.appendToolRecords(conversationId, businessId, copy);
  }

  async load(conversationId: string, businessId: string): Promise<ConversationState | null> {
    this.scope(conversationId, businessId);
    if (this.state === undefined) {
      const revision = this.stateRevision;
      const loaded = structuredClone(await this.states.load(conversationId, businessId));
      // A timed-out read may finish after a later save. Never overwrite that
      // call-owned state with the stale database snapshot.
      if (revision === this.stateRevision) this.state = loaded;
      else return this.state === undefined ? loaded : structuredClone(this.state);
    }
    return structuredClone(this.state);
  }

  async save(conversationId: string, businessId: string, state: ConversationState): Promise<void> {
    this.scope(conversationId, businessId);
    const copy = structuredClone(state);
    this.stateRevision += 1;
    if (this.queue) {
      this.state = structuredClone(copy);
      this.queue.enqueue("state", () => this.states.save(conversationId, businessId, copy));
      return;
    }
    try {
      await this.states.save(conversationId, businessId, copy);
      this.state = structuredClone(copy);
    } catch (error) {
      this.state = undefined;
      throw error;
    }
  }
}
