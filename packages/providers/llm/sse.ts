/**
 * Minimal, dependency-free readers for streaming HTTP bodies:
 *   - Server-Sent Events (OpenAI-compatible and Anthropic streaming APIs)
 *   - newline-delimited JSON (Ollama streaming API)
 *
 * Both are async generators over a fetch `ReadableStream`, tolerant of
 * chunk boundaries falling anywhere (including inside a line).
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as unknown;
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) yield JSON.parse(rest) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Parses tool-call argument JSON leniently: object on success, raw string otherwise. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> | string {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : raw;
  } catch {
    return raw;
  }
}
