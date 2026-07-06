const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 150;

/**
 * Splits document text into retrieval-sized chunks. Prefers paragraph
 * boundaries, falls back to sentence boundaries, and hard-splits only as a
 * last resort. Pure function.
 */
export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkSize) {
      flush();
      chunks.push(...splitLongParagraph(paragraph, chunkSize, overlap));
      continue;
    }
    if (current.length + paragraph.length + 2 > chunkSize) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

function splitLongParagraph(paragraph: string, chunkSize: number, overlap: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [paragraph];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > chunkSize && current) {
      chunks.push(current.trim());
      // Carry a tail of the previous chunk for context continuity.
      current = current.slice(-overlap) + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Hard-split any chunk that still exceeds the limit (e.g. no punctuation).
  return chunks.flatMap((chunk) =>
    chunk.length <= chunkSize
      ? [chunk]
      : Array.from({ length: Math.ceil(chunk.length / chunkSize) }, (_, i) =>
          chunk.slice(i * chunkSize, (i + 1) * chunkSize),
        ),
  );
}
