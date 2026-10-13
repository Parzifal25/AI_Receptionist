import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "@halo/providers/llm/openai-compatible-provider";
import { readNdjson, readSseEvents } from "@halo/providers/llm/sse";

const provider = () => new OpenAICompatibleProvider("groq", "https://example.invalid/v1", "synthetic", "synthetic");
const collect = async <T>(items: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
};

afterEach(() => vi.unstubAllGlobals());

describe("LLM wire failure boundaries", () => {
  it("parses CRLF separators split across arbitrary network chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const text of ["data: one\r", "\n\r", "\ndata: two\r", "\n\r", "\n"]) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    } });
    expect(await collect(readSseEvents(stream))).toEqual([
      { event: null, data: "one" }, { event: null, data: "two" },
    ]);
  });

  it.each(["sse", "ndjson"])("cancels %s upstream on early consumer exit", async (kind) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(kind === "sse" ? "data: one\n\n" : '{"one":1}\n'));
    }, cancel });
    const iterator = kind === "sse" ? readSseEvents(stream) : readNdjson(stream);
    await iterator.next();
    await iterator.return(undefined);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each([null, { choices: [{ message: { content: 42 } }] }, { choices: "bad" },
    { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: -1, completion_tokens: "2" } },
  ])("classifies malformed completion as invalid_response without leaking its payload", async (payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    await expect(provider().complete("synthetic", [])).rejects.toMatchObject({
      code: "PROVIDER_ERROR", details: { category: "invalid_response" },
    });
  });

  it("classifies invalid JSON as invalid_response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private malformed body")));
    await expect(provider().complete("synthetic", [])).rejects.toMatchObject({
      code: "PROVIDER_ERROR", details: { category: "invalid_response" },
    });
  });

  it("does not accept a completion delivered after caller cancellation", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      return Response.json({ choices: [{ message: { content: "late success" } }] });
    }));
    await expect(provider().complete("synthetic", [], { abortSignal: controller.signal })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("classifies malformed successful stream payloads without yielding them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":42}}]}\n\ndata: [DONE]\n\n')));
    await expect(collect(provider().stream("synthetic", []))).rejects.toMatchObject({
      code: "PROVIDER_ERROR", details: { category: "invalid_response" },
    });
  });
});
