import type { SocketEvents, SocketFactory } from "@halo/providers/voice-vendors/websocket";
import { SarvamSttProvider } from "@halo/providers/voice-vendors/sarvam-stt-provider";
import { SarvamTtsProvider } from "@halo/providers/voice-vendors/sarvam-tts-provider";
import { sttContract, ttsContract } from "./voice-provider-contracts";

/**
 * The real Sarvam adapters run against the SAME contract kit as the fakes.
 *
 * WHAT THIS PROVES: the adapters honour HALO's STT/TTS ports — honest
 * capabilities, ordered events, whole-sample audio in the requested format,
 * prompt cancellation, no emission after close.
 *
 * WHAT THIS DOES NOT PROVE: anything about the vendor. The socket below is a
 * stub that speaks the vendor's DOCUMENTED protocol; no credential, no
 * network and no audio are involved. Running this kit against the live
 * endpoint is a credentialled manual job and remains outstanding
 * (docs/KNOWN_LIMITATIONS.md).
 */

/** A stub that answers the documented Sarvam TTS protocol with silence-shaped audio. */
const stubTtsVendor: SocketFactory = (_url, _headers, events: SocketEvents) => {
  let closed = false;
  let codec = "linear16";
  const emit = (message: unknown) => {
    if (!closed) events.message(JSON.stringify(message));
  };
  queueMicrotask(() => {
    if (!closed) events.open();
  });
  return {
    send(text: string) {
      if (closed) return;
      const frame = JSON.parse(text) as { type?: string; data?: { text?: string } };
      if (frame.type === "config") {
        codec = String((frame.data as { output_audio_codec?: string } | undefined)?.output_audio_codec ?? "linear16");
        return;
      }
      if (frame.type !== "flush") return;
      // Deliberately odd-length frames: the port requires whole samples out
      // of the adapter regardless of how the vendor chunks the stream.
      const bytesPerSample = codec === "mulaw" ? 1 : 2;
      for (let i = 0; i < 4; i++) {
        const length = 7 * bytesPerSample + (i % 2);
        emit({ type: "audio", data: { request_id: "stub", audio: Buffer.alloc(length, 0x7f).toString("base64") } });
      }
      emit({ type: "event", data: { event_type: "final" } });
    },
    close() {
      closed = true;
    },
  };
};

/** A stub STT socket that opens and stays quiet: the kit only drives the client side. */
const stubSttVendor: SocketFactory = (_url, _headers, events: SocketEvents) => {
  let closed = false;
  queueMicrotask(() => {
    if (!closed) events.open();
  });
  return {
    send() {},
    close() {
      closed = true;
    },
  };
};

sttContract("sarvam (documented protocol, stubbed socket)", () => new SarvamSttProvider({ apiKey: "contract-key", connect: stubSttVendor }));

ttsContract(
  "sarvam (documented protocol, stubbed socket)",
  () => new SarvamTtsProvider({ apiKey: "contract-key", defaultSpeaker: "contract-voice", connect: stubTtsVendor }),
);
