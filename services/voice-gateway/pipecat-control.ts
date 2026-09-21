import type { WebSocket } from "ws";
import { logger } from "@halo/platform/logger";
import type { AttachedSession, PipecatBridge } from "@halo/voice/pipecat/bridge";
import { encodeCommand, parsePipecatEvent, parsePipecatHello } from "@halo/voice/pipecat/protocol";
import type { RemoteCommandSink } from "@halo/voice/pipecat/remote-session";
import { verifyStreamToken } from "./stream-token";

/**
 * HALO Phase 4 — the Pipecat control socket (`WS /pipecat/control`).
 *
 * Transport only. It authenticates the worker, frames JSON, and hands
 * validated events to the bridge; it makes no conversation decisions and
 * holds no tenant state.
 *
 * Authentication is the SAME mechanism the Phase 3 media socket uses, for
 * the same reason: a worker cannot sign its own upgrade the way a telephony
 * provider signs a webhook, so it presents the short-lived HMAC stream token
 * HALO minted during the signature-verified inbound webhook. The token is
 * bound to the provider call id AND both numbers, so a worker cannot open a
 * session against a number it was not handed — which is what stops it
 * choosing a tenant (docs/PIPECAT_INTEGRATION.md §6).
 *
 * Close codes: 1008 unauthorized (bad/expired/tampered token, bad protocol),
 * 1011 refused (no route, capacity, already ended).
 */

const log = logger.child({ service: "pipecat-control" });

/** One control frame is small; anything larger is not a control frame. */
const MAX_FRAME_BYTES = 32 * 1024;

export interface PipecatControlDeps {
  bridge: PipecatBridge;
  streamTokenSecret: string;
  provider: string;
  now?: () => number;
}

export function attachPipecatControl(ws: WebSocket, deps: PipecatControlDeps): void {
  const now = deps.now ?? Date.now;
  let session: AttachedSession | null = null;
  let greeting = false;
  let closed = false;

  const sink: RemoteCommandSink = {
    send: (command) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeCommand(command));
    },
  };

  ws.on("message", (data, isBinary) => {
    // Audio never crosses this socket. A binary frame is a protocol error.
    if (isBinary) return;
    const raw = data.toString();
    if (raw.length > MAX_FRAME_BYTES) {
      ws.close(1009, "frame_too_large");
      return;
    }
    if (!session) {
      if (greeting) return; // a second hello while the first is in flight
      greeting = true;
      void openSession(raw);
      return;
    }
    const parsed = parsePipecatEvent(raw);
    if (!parsed.ok) {
      log.warn("rejected pipecat frame", { reason: parsed.error, sessionId: session.sessionId });
      return;
    }
    session.deliver(parsed.event);
  });

  ws.on("close", () => {
    closed = true;
    if (session) void session.close("media_disconnected").catch((error: unknown) => log.warn("pipecat close failed", { error }));
  });
  ws.on("error", (error) => log.warn("pipecat control socket error", { error }));

  async function openSession(raw: string): Promise<void> {
    const hello = parsePipecatHello(raw);
    if (!hello.ok) {
      log.warn("pipecat hello rejected", { reason: hello.error });
      ws.close(1008, "unauthorized");
      return;
    }
    const claims = {
      providerCallId: hello.hello.providerCallId,
      from: hello.hello.from,
      to: hello.hello.to,
    };
    const verified = verifyStreamToken(deps.streamTokenSecret, hello.hello.token, claims, now());
    if (!verified.ok) {
      log.warn("pipecat stream token rejected", { reason: verified.reason });
      ws.close(1008, "unauthorized");
      return;
    }
    const attached = await deps.bridge.attach({
      provider: deps.provider,
      providerCallId: claims.providerCallId,
      from: claims.from,
      to: claims.to,
      commands: sink,
    });
    if (!attached.ok) {
      log.warn("pipecat session refused", { reason: attached.reason, providerCallId: claims.providerCallId });
      ws.close(1011, attached.reason);
      return;
    }
    if (closed) {
      await attached.session.close("media_disconnected");
      return;
    }
    session = attached.session;
    log.info("pipecat session attached", {
      sessionId: session.sessionId,
      // Correlation only; never transcript text.
      correlationId: session.identity.correlationId,
    });
  }
}
