import { WebSocket } from "ws";

/**
 * HALO Phase 4.5 — the one WebSocket seam the real speech adapters use.
 *
 * Vendor adapters never touch `ws` directly: they take a `SocketFactory`,
 * which production wires to `wsSocketFactory` and tests replace with an
 * in-memory double. That is what makes an adapter's protocol handling —
 * ordering, cancellation, error mapping, malformed frames — testable
 * offline, with no credentials and no network.
 *
 * Deliberately tiny: text frames out, text frames in. Both vendors used so
 * far carry audio as base64 inside JSON, so no binary path exists here; add
 * one only when a vendor that needs it is actually wired.
 */

export interface SocketEvents {
  open(): void;
  /** One inbound text frame. Binary frames are decoded as UTF-8 text. */
  message(text: string): void;
  close(code: number, reason: string): void;
  /** `status` is the HTTP status when the upgrade itself was refused. */
  error(error: Error & { status?: number }): void;
}

export interface VendorSocket {
  send(text: string): void;
  /** Idempotent. Further `send`s after this are silently dropped. */
  close(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>, events: SocketEvents) => VendorSocket;

/** How long a vendor gets to answer a close handshake before the socket is torn down. */
const CLOSE_GRACE_MS = 1_000;

/** Production factory: a `ws` client that reports upgrade failures with their status. */
export const wsSocketFactory: SocketFactory = (url, headers, events) => {
  const socket = new WebSocket(url, { headers });
  let closed = false;
  let closing = false;

  socket.on("open", () => events.open());
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    events.message(Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as Buffer).toString("utf8"));
  });
  socket.on("close", (code: number, reason: Buffer) => {
    closed = true;
    events.close(code, reason.toString("utf8"));
  });
  socket.on("error", (error: Error) => events.error(error));
  // A refused upgrade (401, 403, 429…) is the single most useful signal an
  // adapter gets for classifying a credential or quota failure, and `ws`
  // only exposes it on this event.
  socket.on("unexpected-response", (_request, response: { statusCode?: number; statusMessage?: string }) => {
    const error = new Error(`websocket upgrade rejected: ${response.statusCode ?? "?"} ${response.statusMessage ?? ""}`.trim()) as Error & {
      status?: number;
    };
    error.status = response.statusCode;
    events.error(error);
  });

  return {
    send(text: string) {
      if (closed || closing || socket.readyState !== WebSocket.OPEN) return;
      socket.send(text);
    },
    close() {
      if (closing) return;
      closing = true;
      try {
        // Graceful: frames already queued (a vendor's "end"/"flush") still
        // flush. The timer is the promptness guarantee the TTS port's
        // cancellation contract needs — a vendor that never answers the
        // close handshake must not hold the connection open.
        socket.close();
      } catch {
        // never opened
      }
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          // already gone
        }
      }, CLOSE_GRACE_MS);
      timer.unref?.();
    },
  };
};
