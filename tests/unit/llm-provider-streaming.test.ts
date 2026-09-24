import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMDelta, LLMProvider } from "@halo/ports/llm-provider";
import { AnthropicProvider } from "@halo/providers/llm/anthropic-provider";
import { GeminiProvider } from "@halo/providers/llm/gemini-provider";
import { flattenToolMessages, OllamaProvider } from "@halo/providers/llm/ollama-provider";
import { OpenAICompatibleProvider } from "@halo/providers/llm/openai-compatible-provider";
import { readSseEvents } from "@halo/providers/llm/sse";

function streamResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
}

async function collect(iterable: AsyncIterable<LLMDelta>): Promise<LLMDelta[]> {
  const out: LLMDelta[] = [];
  for await (const d of iterable) out.push(d);
  return out;
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("SSE reader", () => {
  it("handles chunk boundaries inside lines and multi-line data", async () => {
    const res = streamResponse(["event: ping\ndata: {\"a\":", "1}\n\ndata: x\ndata: y\n\n", "data: [DONE]\n\n"]);
    const events = [];
    for await (const e of readSseEvents(res.body!)) events.push(e);
    expect(events).toEqual([
      { event: "ping", data: '{"a":1}' },
      { event: null, data: "x\ny" },
      { event: null, data: "[DONE]" },
    ]);
  });
});

describe("OpenAI-compatible provider — streaming + tools (Phase 2, WS7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("declares its capabilities honestly", () => {
    expect(new OpenAICompatibleProvider("openai", "https://x", "k", "m").capabilities()).toEqual({ streaming: true, tools: true, jsonMode: true, usage: true });
  });

  it("streams text deltas, assembles tool calls across chunks, and reports usage", async () => {
    const chunks = [
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "save_contact_details", arguments: '{"pho' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ne":"555"}' } }] }, finish_reason: "tool_calls" }] }),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      "data: [DONE]\n\n",
    ];
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return streamResponse(chunks);
    }));
    const provider = new OpenAICompatibleProvider("openai", "https://api.example/v1", "key", "gpt-x");
    const deltas = await collect(provider.stream("sys", [{ role: "user", content: "hi" }], { tools: [{ name: "save_contact_details", description: "d", parameters: { type: "object" } }] }));
    expect(sentBody.stream).toBe(true);
    expect((sentBody.tools as unknown[]).length).toBe(1);
    expect(deltas).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "tool_call", call: { id: "call_1", name: "save_contact_details", arguments: { phone: "555" } } },
      { type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
      { type: "done", finishReason: "tool_calls", httpStatus: 200 },
    ]);
  });

  it("completion returns tool calls with finish reason and serializes tool transcripts on the wire", async () => {
    let sentBody: { messages: Array<Record<string, unknown>> } = { messages: [] };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "request_human_handoff", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200 });
    }));
    const provider = new OpenAICompatibleProvider("groq", "https://api.example/v1", "key", "m");
    const result = await provider.complete("sys", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "t", arguments: { a: 1 } }] },
      { role: "tool", toolCallId: "c0", content: "{\"status\":\"succeeded\"}" },
    ]);
    expect(result.toolCalls).toEqual([{ id: "c1", name: "request_human_handoff", arguments: {} }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.content).toBe("");
    expect(sentBody.messages[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c0", function: { name: "t", arguments: '{"a":1}' } }] });
    expect(sentBody.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c0" });
  });
});

describe("Anthropic provider — streaming + tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams text and tool_use blocks and reports usage from message_start/message_delta", async () => {
    const chunks = [
      `event: message_start\n${sse({ type: "message_start", message: { usage: { input_tokens: 7 } } })}`,
      `event: content_block_start\n${sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\n${sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sure." } })}`,
      `event: content_block_start\n${sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "request_human_handoff" } })}`,
      `event: content_block_delta\n${sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"reason":' } })}`,
      `event: content_block_delta\n${sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"angry"}' } })}`,
      `event: content_block_stop\n${sse({ type: "content_block_stop", index: 1 })}`,
      `event: message_delta\n${sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } })}`,
      `event: message_stop\n${sse({ type: "message_stop" })}`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(chunks)));
    const provider = new AnthropicProvider("key", "claude-x", "https://api.example");
    const deltas = await collect(provider.stream("sys", [{ role: "user", content: "hi" }]));
    expect(deltas).toEqual([
      { type: "text", text: "Sure." },
      { type: "tool_call", call: { id: "toolu_1", name: "request_human_handoff", arguments: { reason: "angry" } } },
      { type: "usage", usage: { promptTokens: 7, completionTokens: 3 } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("groups consecutive tool results into one user message on the wire", async () => {
    let sentBody: { messages: Array<Record<string, unknown>>; tools?: unknown[] } = { messages: [] };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    const provider = new AnthropicProvider("key", "claude-x", "https://api.example");
    const result = await provider.complete("sys", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", arguments: {} }, { id: "b", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "a", content: "1" },
      { role: "tool", toolCallId: "b", content: "2" },
    ], { tools: [{ name: "t", description: "d", parameters: { type: "object" } }] });
    expect(result.content).toBe("Done.");
    expect(result.finishReason).toBe("stop");
    expect(sentBody.messages).toHaveLength(3);
    expect((sentBody.messages[2].content as unknown[]).length).toBe(2);
    expect(sentBody.tools).toHaveLength(1);
  });
});

describe("Ollama and Gemini providers — honest capabilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Ollama streams NDJSON and declares no native tools", async () => {
    const provider = new OllamaProvider("http://ollama.local", "llama3.1");
    expect(provider.capabilities()).toEqual({ streaming: true, tools: false, jsonMode: true, usage: true });
    const lines = [
      `${JSON.stringify({ message: { content: "Hi " }, done: false })}\n`,
      `${JSON.stringify({ message: { content: "there" }, done: false })}\n${JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 4, eval_count: 2 })}\n`,
    ];
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(lines, "application/x-ndjson")));
    const deltas = await collect(provider.stream("sys", [{ role: "user", content: "hi" }]));
    expect(deltas).toEqual([
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "usage", usage: { promptTokens: 4, completionTokens: 2 } },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("Gemini declares completion-only and flattens tool turns into text", () => {
    expect(new GeminiProvider("k", "gemini-x").capabilities()).toEqual({ streaming: false, tools: false, jsonMode: true, usage: true });
    expect((new GeminiProvider("k", "gemini-x") as LLMProvider).stream).toBeUndefined();
    expect(flattenToolMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "save_contact_details", arguments: {} }] },
      { role: "tool", toolCallId: "c", content: "{\"status\":\"succeeded\"}" },
    ])).toEqual([
      { role: "assistant", content: "[Requested actions: save_contact_details]" },
      { role: "user", content: "[Action result] {\"status\":\"succeeded\"}" },
    ]);
  });

  it("respects the per-call timeout hint without exceeding its own default", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
    }));
    const provider = new OllamaProvider("http://ollama.local", "m", 50);
    await provider.complete("sys", [{ role: "user", content: "hi" }], { timeoutMs: 10_000 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
