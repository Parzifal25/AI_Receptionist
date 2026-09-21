import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@halo/platform/logger";
import type { MediaStreamCodec, TelephonyProvider } from "@halo/ports/telephony-provider";
import type { VoiceGateway } from "@halo/voice/gateway";
import type { VoiceOutput } from "@halo/voice/voice-session";
import type { PipecatBridge } from "@halo/voice/pipecat/bridge";
import type { GatewayConfig } from "./config";
import { attachPipecatControl } from "./pipecat-control";
import { mintStreamToken, verifyStreamToken } from "./stream-token";

/**
 * HALO Phase 3 — the voice gateway process (plan §P5.1: the only process
 * separation, because a minutes-long stateful bidirectional audio session is
 * the wrong shape for request/response).
 *
 * HTTP  POST /telephony/:provider/inbound   verified webhook → media-stream answer
 *       POST /telephony/:provider/status    verified webhook → call state
 *       GET  /health                        liveness + live session count
 * WS    /media                              bidirectional audio (in-process engine)
 * WS    /pipecat/control                    text control plane (Pipecat engine)
 *
 * Trust: both HTTP routes verify the provider signature and FAIL CLOSED; the
 * WebSocket carries no provider signature, so it is authenticated by a
 * short-lived stream token minted during the verified webhook and bound to
 * the call id and both numbers. Tenant identity is never taken from either
 * payload: the gateway resolves it from the dialled number server-side.
 */

const log = logger.child({ service: "voice-gateway-http" });

const MAX_BODY_BYTES = 64 * 1024;

export interface GatewayServerDeps {
  config: GatewayConfig;
  gateway: VoiceGateway;
  telephony: TelephonyProvider;
  /**
   * Answer only when the dialled number routes to an agent that is actually
   * configured for voice. Rejecting at the webhook is honest and cheap; an
   * unconfigured agent must never pick up (packages/voice/session-config.ts).
   */
  canAnswer?(params: { to: string; from: string }): Promise<boolean>;
  /** Required when `config.mediaEngine === "pipecat"`; unused otherwise. */
  pipecat?: PipecatBridge;
  now?: () => number;
}

export interface GatewayServer {
  server: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createGatewayServer(deps: GatewayServerDeps): GatewayServer {
  const { config, gateway, telephony } = deps;
  const now = deps.now ?? Date.now;
  const wss = new WebSocketServer({ noServer: true });
  let shuttingDown = false;

  if (config.mediaEngine === "pipecat" && !deps.pipecat) {
    // Fail closed at construction: a gateway configured for Pipecat but
    // built without the bridge would answer calls it can never serve.
    throw new Error("voice gateway: VOICE_MEDIA_ENGINE=pipecat requires a PipecatBridge");
  }

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error) => {
      log.error("gateway request failed", { error });
      send(res, 500, "application/json", JSON.stringify({ error: "internal_error" }));
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, shuttingDown ? 503 : 200, "application/json", JSON.stringify({
        status: shuttingDown ? "draining" : "ok",
        sessions: gateway.activeSessions,
        provider: telephony.name,
      }));
    }

    const match = /^\/telephony\/([a-z0-9-]+)\/(inbound|status)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) return send(res, 404, "application/json", JSON.stringify({ error: "not_found" }));
    if (match[1] !== telephony.name) return send(res, 404, "application/json", JSON.stringify({ error: "unknown_provider" }));
    if (shuttingDown) return send(res, 503, "application/json", JSON.stringify({ error: "draining" }));

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      return send(res, 413, "application/json", JSON.stringify({ error: "payload_too_large" }));
    }

    const request = {
      // The signed URL must be the public one the provider called.
      url: new URL(url.pathname + url.search, publicHttpBase(config.publicWsUrl)).toString(),
      method: req.method,
      headers: lowerHeaders(req.headers),
      rawBody,
    };
    const verification = telephony.verifyWebhook(request);
    if (!verification.ok) {
      log.warn("rejected telephony webhook", { reason: verification.reason, path: url.pathname });
      return send(res, verification.reason === "not_configured" ? 503 : 403, "application/json", JSON.stringify({ error: verification.reason }));
    }

    const event = telephony.parseWebhook(request);
    if (match[2] === "status") {
      await gateway.handleProviderEvent(event);
      return send(res, 204, "application/json", "");
    }
    if (event.kind !== "inbound_call") return send(res, 204, "application/json", "");

    if (deps.canAnswer && !(await deps.canAnswer({ to: event.to, from: event.from }))) {
      log.warn("declining inbound call", { to: event.to });
      const rejection = telephony.rejectCall({ reason: "unknown_number" });
      return send(res, 200, rejection.contentType, rejection.body);
    }

    const token = mintStreamToken(
      config.streamTokenSecret,
      { providerCallId: event.providerCallId, from: event.from, to: event.to },
      config.streamTokenTtlMs,
      now(),
    );
    const pipecat = config.mediaEngine === "pipecat";
    const answer = telephony.answerWithMediaStream({
      // With Pipecat the provider streams audio to the worker, not to us;
      // the worker then opens the control socket back to HALO with the same
      // token. Tenant identity still comes only from the dialled number.
      streamUrl: pipecat ? config.pipecatMediaWsUrl! : config.publicWsUrl,
      parameters: {
        token,
        callId: event.providerCallId,
        from: event.from,
        to: event.to,
        ...(pipecat ? { haloControlUrl: controlUrl(config.publicWsUrl) } : {}),
      },
    });
    return send(res, 200, answer.contentType, answer.body);
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    if (deps.pipecat && url.pathname.startsWith("/pipecat/control")) {
      const bridge = deps.pipecat;
      wss.handleUpgrade(req, socket, head, (ws) =>
        attachPipecatControl(ws, {
          bridge,
          streamTokenSecret: config.streamTokenSecret,
          provider: telephony.name,
          now,
        }),
      );
      return;
    }
    if (!url.pathname.startsWith("/media")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachMedia(ws));
  });

  function attachMedia(ws: WebSocket): void {
    const codec: MediaStreamCodec = telephony.createMediaCodec();
    let sessionId: string | null = null;
    /** Latched synchronously: `sessionId` is only set after an await, so a
     *  duplicate `start` frame would otherwise enter the async path twice. */
    let starting = false;
    let closed = false;

    const output: VoiceOutput = {
      format: codec.format,
      supportsMarks: codec.supportsMarks,
      sendAudio: (audio) => safeSend(ws, codec.encodeAudio(audio)),
      clear: () => safeSend(ws, codec.encodeClear()),
      mark: (name) => safeSend(ws, codec.encodeMark(name)),
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // media-stream protocols are JSON text frames
      for (const event of codec.decode(data.toString())) {
        if (event.type === "start") {
          if (sessionId || starting) continue;
          starting = true;
          void startSession(event.providerCallId, event.parameters);
          continue;
        }
        // Everything before a verified `start` is dropped.
        if (!sessionId) continue;
        gateway.receiveEvent(sessionId, event);
      }
    });

    ws.on("close", () => {
      closed = true;
      if (sessionId) gateway.mediaDisconnected(sessionId);
    });
    ws.on("error", (error) => log.warn("media socket error", { error }));

    async function startSession(providerCallId: string, parameters: Record<string, string>): Promise<void> {
      const claims = {
        providerCallId: parameters.callId ?? providerCallId,
        from: parameters.from ?? "",
        to: parameters.to ?? "",
      };
      const token = parameters.token ?? "";
      const verified = verifyStreamToken(config.streamTokenSecret, token, claims, now());
      if (!verified.ok || claims.providerCallId !== providerCallId) {
        log.warn("media socket rejected", { reason: verified.ok ? "call_id_mismatch" : verified.reason });
        ws.close(1008, "unauthorized");
        return;
      }
      const result = await gateway.startSession({
        provider: telephony.name,
        providerCallId,
        from: claims.from,
        to: claims.to,
        output,
      });
      if (!result.ok) {
        log.warn("media socket refused", { reason: result.reason, providerCallId });
        ws.close(1011, result.reason);
        return;
      }
      if (closed) {
        gateway.mediaDisconnected(result.sessionId);
        return;
      }
      sessionId = result.sessionId;
    }
  }

  return {
    server,
    listen(port = config.port) {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    async close() {
      shuttingDown = true;
      await gateway.shutdown();
      for (const client of wss.clients) client.close(1001, "shutting down");
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function safeSend(ws: WebSocket, message: string): void {
  if (ws.readyState === ws.OPEN) ws.send(message);
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value[0] ?? "";
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Where a Pipecat worker reaches HALO's control plane for this deployment. */
function controlUrl(publicWsUrl: string): string {
  const url = new URL(publicWsUrl);
  url.pathname = "/pipecat/control";
  url.search = "";
  return url.toString();
}

/** The provider signs the public https:// URL, not the internal bind address. */
function publicHttpBase(publicWsUrl: string): string {
  const url = new URL(publicWsUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "/";
  url.search = "";
  return url.toString();
}
