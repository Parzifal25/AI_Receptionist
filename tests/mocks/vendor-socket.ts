import type { SocketEvents, SocketFactory, VendorSocket } from "@halo/providers/voice-vendors/websocket";

/**
 * An in-memory `VendorSocket` for speech-adapter tests.
 *
 * The real adapters talk to their vendor through the `SocketFactory` seam,
 * so every protocol behaviour — frame shapes, ordering, error mapping,
 * cancellation, malformed input — is testable with no credentials and no
 * network. This is the double that makes that true.
 */
export class ScriptedSocket implements VendorSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    private readonly events: SocketEvents,
  ) {}

  /** The parsed JSON of every frame the adapter sent. */
  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  // --- vendor side -----------------------------------------------------------

  open(): void {
    this.events.open();
  }

  emit(message: unknown): void {
    this.events.message(typeof message === "string" ? message : JSON.stringify(message));
  }

  dropped(code = 1006, reason = "abnormal"): void {
    this.closed = true;
    this.events.close(code, reason);
  }

  refuse(status: number, message = "upgrade rejected"): void {
    const error = new Error(message) as Error & { status?: number };
    error.status = status;
    this.events.error(error);
  }
}

export interface SocketHarness {
  factory: SocketFactory;
  readonly sockets: ScriptedSocket[];
  /** The most recently created socket. */
  readonly last: ScriptedSocket;
}

export function socketHarness(options: { autoOpen?: boolean } = {}): SocketHarness {
  const sockets: ScriptedSocket[] = [];
  const factory: SocketFactory = (url, headers, events) => {
    const socket = new ScriptedSocket(url, headers, events);
    sockets.push(socket);
    // Opening on a microtask mirrors a real connection: the adapter always
    // has a window in which it must buffer rather than send.
    if (options.autoOpen !== false) queueMicrotask(() => socket.open());
    return socket;
  };
  return {
    factory,
    sockets,
    get last() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("no socket was opened");
      return socket;
    },
  };
}
