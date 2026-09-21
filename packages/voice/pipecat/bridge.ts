import type { CallEndReason } from "@halo/core/domain/voice";
import { logger } from "@halo/platform/logger";
import type { MediaSessionRequest, StartSessionResult, VoiceGateway } from "../gateway";
import type { VoiceMediaSession } from "../media-session";
import type { VoiceOutput } from "../voice-session";
import { RemoteVoiceSession, type RemoteCommandSink } from "./remote-session";
import type { PipecatEvent, VoiceSessionIdentity } from "./protocol";

/**
 * HALO Phase 4 — the Pipecat bridge (docs/PIPECAT_INTEGRATION.md §4).
 *
 * The one place that knows a call's media loop is remote. It gives the
 * gateway a `createMediaSession` factory that builds `RemoteVoiceSession`s
 * and routes each engine's commands back to the control socket that opened
 * the call.
 *
 * Everything else — routing the dialled number to a tenant, the call row,
 * the technical state machine, transcript and event persistence, outcomes,
 * usage, capacity, the transfer boundary — is the gateway's, unchanged, and
 * shared byte-for-byte with the in-process engine.
 *
 * The bridge never reads identity from a frame. `attach()` is called only
 * after the transport verified the stream token HALO minted during the
 * signature-verified telephony webhook, and `from`/`to` are the values that
 * token was signed over — the webhook's, never the worker's.
 *
 * Sockets are keyed by PROVIDER CALL ID, which the transport knows before
 * the session exists. That matters: the greeting is emitted synchronously
 * inside `start()`, before `startSession` has returned a session id, so a
 * sink keyed on the session id would drop the first thing the caller hears.
 */

const log = logger.child({ service: "pipecat-bridge" });

/** HALO sends no audio on this path; the gateway's output port is unused. */
const SILENT_OUTPUT: VoiceOutput = {
  format: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
  supportsMarks: false,
  sendAudio: () => {},
  clear: () => {},
  mark: () => {},
};

export interface AttachedSession {
  sessionId: string;
  identity: VoiceSessionIdentity;
  /** One validated control frame from the worker. */
  deliver(event: PipecatEvent): void;
  /** The control socket went away, with or without a `bye`. */
  close(reason: CallEndReason): Promise<void>;
}

export type AttachResult =
  | { ok: true; session: AttachedSession }
  | { ok: false; reason: Extract<StartSessionResult, { ok: false }>["reason"] };

export interface PipecatBridgeOptions {
  playbackTimeoutMs?: number;
}

export class PipecatBridge {
  private gateway: VoiceGateway | null = null;
  private readonly sinks = new Map<string, RemoteCommandSink>();
  private readonly engines = new Map<string, RemoteVoiceSession>();

  constructor(private readonly options: PipecatBridgeOptions = {}) {}

  /**
   * Pass this as `VoiceGatewayDeps.createMediaSession`. It is defined before
   * the gateway exists (the gateway takes it in its constructor), so the
   * gateway is injected afterwards with `bindGateway`.
   */
  readonly createMediaSession = (request: MediaSessionRequest): VoiceMediaSession => {
    const key = this.key(request.ctx.call.provider, request.ctx.call.providerCallId);
    const engine = new RemoteVoiceSession({
      identity: identityFor(request),
      turns: request.turns,
      config: request.config,
      hooks: request.hooks,
      commands: {
        send: (command) => {
          const sink = this.sinks.get(key);
          if (!sink) {
            // The socket closed between a command being decided and sent.
            // The session is already ending; dropping the frame is correct.
            log.warn("dropping pipecat command for a detached socket", { key, command: command.type });
            return;
          }
          sink.send(command);
        },
      },
      now: request.now,
      ...(this.options.playbackTimeoutMs !== undefined ? { playbackTimeoutMs: this.options.playbackTimeoutMs } : {}),
    });
    this.engines.set(key, engine);
    return engine;
  };

  bindGateway(gateway: VoiceGateway): void {
    this.gateway = gateway;
  }

  get activeSessions(): number {
    return this.engines.size;
  }

  /** Start (or re-attach to) the session for an already-authenticated call. */
  async attach(params: {
    provider: string;
    providerCallId: string;
    from: string;
    to: string;
    commands: RemoteCommandSink;
  }): Promise<AttachResult> {
    const gateway = this.gateway;
    if (!gateway) throw new Error("pipecat bridge: gateway not bound");
    const key = this.key(params.provider, params.providerCallId);
    // Registered BEFORE startSession, so the greeting has somewhere to go.
    this.sinks.set(key, params.commands);

    let result: StartSessionResult;
    try {
      result = await gateway.startSession({
        provider: params.provider,
        providerCallId: params.providerCallId,
        from: params.from,
        to: params.to,
        output: SILENT_OUTPUT,
      });
    } catch (error) {
      this.release(key);
      throw error;
    }
    if (!result.ok) {
      this.release(key);
      return { ok: false, reason: result.reason };
    }
    const engine = this.engines.get(key);
    if (!engine) {
      // Only reachable if the gateway was built without this bridge's
      // factory. Refusing is safer than serving a call with no media engine.
      await gateway.endSession(result.sessionId, "rejected");
      this.release(key);
      return { ok: false, reason: "provider_mismatch" };
    }

    return {
      ok: true,
      session: {
        sessionId: result.sessionId,
        identity: engine.identity,
        deliver: (event) => engine.receiveControl(event),
        close: async (reason) => {
          try {
            await gateway.endSession(result.sessionId, reason);
          } finally {
            this.release(key);
          }
        },
      },
    };
  }

  private release(key: string): void {
    this.sinks.delete(key);
    this.engines.delete(key);
  }

  private key(provider: string, providerCallId: string): string {
    return `${provider}|${providerCallId}`;
  }
}

function identityFor(request: MediaSessionRequest): VoiceSessionIdentity {
  const { ctx } = request;
  return {
    tenantId: ctx.call.businessId,
    agentId: ctx.call.agentId,
    agentVersionId: ctx.call.agentVersionId,
    agentVersion: ctx.route.version.version,
    callId: ctx.call.id,
    // One call, one session: the gateway keys its registry by call id too.
    sessionId: ctx.call.id,
    conversationId: ctx.conversationId,
    correlationId: ctx.correlationId,
  };
}
