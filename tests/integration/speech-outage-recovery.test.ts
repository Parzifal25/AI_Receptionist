import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackSttProvider } from "@halo/providers/voice-vendors/fallback-stt-provider";
import { FallbackTtsProvider } from "@halo/providers/voice-vendors/fallback-tts-provider";
import { SarvamSttProvider } from "@halo/providers/voice-vendors/sarvam-stt-provider";
import { SarvamTtsProvider } from "@halo/providers/voice-vendors/sarvam-tts-provider";
import { FakeSttProvider } from "@halo/providers/voice-fakes/fake-stt-provider";
import { FakeTtsProvider } from "@halo/providers/voice-fakes/fake-tts-provider";
import type { SttEvent } from "@halo/ports/streaming-stt-provider";
import { SIM_STT_TEXT, SIM_TTS_AUDIO, SimSarvam } from "../mocks/sim-sarvam";

/**
 * Sarvam-first fallback across an outage and a recovery, with the REAL Sarvam
 * adapters and `ws` client against a simulated endpoint on loopback. No
 * vendor is contacted. The circuit's clock is injected, so cooldowns are
 * advanced, never waited for; nothing here depends on a timeout elapsing.
 */

const COOLDOWN = 30_000;
const format = { encoding: "pcm16le" as const, sampleRate: 8000, channels: 1 as const };
const line = { text: "మీకు ఎలా సహాయం చేయగలను", language: "te-IN", format };

let sim: SimSarvam;
let now: number;
let changes: string[];
const circuit = () => ({ failureThreshold: 2, cooldownMs: COOLDOWN, now: () => now, onChange: (c: { provider: string; state: string }) => changes.push(`${c.provider}:${c.state}`) });

beforeEach(async () => { sim = await SimSarvam.start(); now = 0; changes = []; });
afterEach(async () => { await sim.stop(); });

describe("TTS: Sarvam outage, fallback, recovery", () => {
  function setup() {
    const fallback = new FakeTtsProvider();
    const tts = new FallbackTtsProvider([
      { provider: new SarvamTtsProvider({ apiKey: "sim-key", defaultSpeaker: "anushka", model: "synthetic-tts-model", baseUrl: sim.baseUrl }) },
      { provider: fallback }], circuit());
    /** Speaks one line and says who spoke it, judged by the audio itself. */
    const speak = async (signal = new AbortController().signal): Promise<"sarvam" | "fallback" | "silence"> => {
      const audio: number[] = [];
      for await (const chunk of tts.synthesize(line, signal)) audio.push(...chunk);
      if (!audio.length) return "silence";
      return audio.length === SIM_TTS_AUDIO.byteLength && audio.every(byte => byte === SIM_TTS_AUDIO[0]) ? "sarvam" : "fallback";
    };
    return { fallback, tts, speak };
  }

  it("opens after two failed lines, stops calling Sarvam, and returns to it after one successful probe", async () => {
    const { speak } = setup();
    expect(await speak()).toBe("sarvam");
    sim.mode = "unavailable";
    expect([await speak(), await speak()]).toEqual(["fallback", "fallback"]);
    expect(sim.attempts.tts).toBe(3);
    expect(changes).toEqual(["sarvam-tts:open"]);
    for (let i = 0; i < 4; i++) expect(await speak()).toBe("fallback");
    expect(sim.attempts.tts).toBe(3); // the circuit is open: Sarvam is not asked

    sim.mode = "healthy"; // Sarvam is back, but nobody knows until the cooldown ends
    now += COOLDOWN - 1;
    expect(await speak()).toBe("fallback");
    expect(sim.attempts.tts).toBe(3);
    now += 1;
    expect(await speak()).toBe("sarvam"); // the half-open probe
    expect(changes).toEqual(["sarvam-tts:open", "sarvam-tts:half_open", "sarvam-tts:closed"]);
    expect([await speak(), await speak()]).toEqual(["sarvam", "sarvam"]);
    expect(sim.attempts.tts).toBe(6);
  });

  it("a probe during a continuing outage is still spoken, and the next probe waits twice as long", async () => {
    const { speak } = setup();
    sim.mode = "unavailable";
    await speak(); await speak();
    now += COOLDOWN;
    expect(await speak()).toBe("fallback"); // probe failed, caller still hears the line
    expect(sim.attempts.tts).toBe(3);
    now += COOLDOWN;
    expect(await speak()).toBe("fallback");
    expect(sim.attempts.tts).toBe(3); // backed off: not probed again yet
    sim.mode = "healthy"; now += COOLDOWN;
    expect(await speak()).toBe("sarvam");
    expect(changes).toEqual(["sarvam-tts:open", "sarvam-tts:half_open", "sarvam-tts:open", "sarvam-tts:half_open", "sarvam-tts:closed"]);
  });

  it("concurrent lines when the outage starts all reach the caller and open the circuit once", async () => {
    const { speak } = setup();
    sim.mode = "unavailable";
    expect(await Promise.all(Array.from({ length: 5 }, () => speak()))).toEqual(Array(5).fill("fallback"));
    expect(sim.attempts.tts).toBe(5); // all five were already in flight
    expect(changes).toEqual(["sarvam-tts:open"]);
    expect(await speak()).toBe("fallback");
    expect(sim.attempts.tts).toBe(5);
  });

  it("concurrent lines after the cooldown send exactly one probe; the rest do not wait for it", async () => {
    const { speak } = setup();
    sim.mode = "unavailable";
    await speak(); await speak();
    sim.mode = "healthy"; now += COOLDOWN;
    const release = sim.hold(); // Sarvam accepts the probe but is slow to answer
    const probe = speak();
    await sim.reached("tts", 3);
    // While the probe is unanswered, four more lines are spoken by the fallback at once.
    expect(await Promise.all(Array.from({ length: 4 }, () => speak()))).toEqual(Array(4).fill("fallback"));
    expect(sim.attempts.tts).toBe(3);
    release();
    expect(await probe).toBe("sarvam");
    expect(await Promise.all(Array.from({ length: 4 }, () => speak()))).toEqual(Array(4).fill("sarvam"));
    expect(sim.attempts.tts).toBe(7);
    expect(changes).toEqual(["sarvam-tts:open", "sarvam-tts:half_open", "sarvam-tts:closed"]);
  });

  it("a barge-in during the probe decides nothing: the next line probes again", async () => {
    const { speak } = setup();
    sim.mode = "unavailable";
    await speak(); await speak();
    sim.mode = "healthy"; now += COOLDOWN;
    const release = sim.hold(), abort = new AbortController();
    const cut = speak(abort.signal);
    await sim.reached("tts", 3);
    abort.abort();
    expect(await cut).toBe("silence");
    release();
    expect(await speak()).toBe("sarvam");
    expect(sim.attempts.tts).toBe(4);
  });

  it("a rejected credential or an unknown voice is surfaced, never spoken by the fallback, never an outage", async () => {
    const { fallback, tts, speak } = setup();
    for (const [mode, code] of [["unauthorized", "auth"], ["bad_voice", "unsupported_voice"]] as const) {
      sim.mode = mode;
      for (let i = 0; i < 3; i++) await expect(speak()).rejects.toMatchObject({ name: "TtsError", code, retryable: false });
    }
    expect(fallback.requests).toHaveLength(0);
    expect(changes).toEqual([]);
    expect(sim.attempts.tts).toBe(6); // every line still went to Sarvam: the circuit stayed closed
    sim.mode = "healthy";
    expect(await speak()).toBe("sarvam");
    expect(tts.capabilities().voices).toContain("anushka");
  });
});

describe("STT: Sarvam outage, fallback, recovery", () => {
  const options = { language: "te-IN", alternativeLanguages: [], format, interimResults: true, phraseHints: [] };
  function setup() {
    const fallback = new FakeSttProvider();
    const stt = new FallbackSttProvider([new SarvamSttProvider({ apiKey: "sim-key", model: "synthetic-stt-model", baseUrl: sim.baseUrl }), fallback], undefined, circuit());
    const open = () => {
      const events: SttEvent[] = [], own = { ...options };
      const stream = stt.open(own, event => events.push(event));
      const finals = () => events.flatMap(event => (event.type === "final" ? [event] : []));
      let answered = 0;
      /** One caller utterance, answered by whichever recognizer holds the stream. */
      const utter = async () => {
        const count = finals().length;
        stream.write(new Uint8Array(320)); stream.finalize();
        await vi.waitFor(() => {
          // The fallback is a fake: it "hears" as soon as it has been asked to finalize.
          const taken = fallback.streams.find(candidate => candidate.options === own);
          if (taken && taken.finalizeCalls > answered) { answered = taken.finalizeCalls; taken.final("fallback heard this"); }
          expect(finals().length).toBe(count + 1);
        });
        return finals().at(-1)!;
      };
      return { events, stream, finals, utter };
    };
    /** Opens a stream, says one thing, and reports who recognised it. */
    const call = async (): Promise<"sarvam" | "fallback"> => {
      const session = open(), final = await session.utter();
      await session.stream.close();
      return final.text === SIM_STT_TEXT ? "sarvam" : "fallback";
    };
    return { fallback, open, call };
  }

  it("opens after two failed streams, opens later streams on the fallback, and returns after one successful probe", async () => {
    const { fallback, call } = setup();
    expect(await call()).toBe("sarvam");
    sim.mode = "unavailable";
    expect([await call(), await call()]).toEqual(["fallback", "fallback"]);
    expect(sim.attempts.stt).toBe(3);
    expect(changes).toEqual(["sarvam-stt:open"]);
    for (let i = 0; i < 3; i++) expect(await call()).toBe("fallback");
    expect(sim.attempts.stt).toBe(3);
    // Audio written before the fallback took over was replayed into it, once.
    expect(fallback.streams.every(stream => stream.bytesWritten === 320 && stream.finalizeCalls === 1)).toBe(true);

    sim.mode = "healthy"; now += COOLDOWN - 1;
    expect(await call()).toBe("fallback");
    now += 1;
    expect(await call()).toBe("sarvam");
    expect(changes).toEqual(["sarvam-stt:open", "sarvam-stt:half_open", "sarvam-stt:closed"]);
    expect(await call()).toBe("sarvam");
    expect(sim.attempts.stt).toBe(5); expect(fallback.streams).toHaveLength(6);
  });

  it("concurrent streams after the cooldown send exactly one probe to Sarvam", async () => {
    const { fallback, open } = setup();
    sim.mode = "unavailable";
    for (let i = 0; i < 2; i++) { const failed = open(); await vi.waitFor(() => expect(fallback.streams).toHaveLength(i + 1)); await failed.stream.close(); }
    sim.mode = "healthy"; now += COOLDOWN;
    const sessions = [open(), open(), open()];
    await vi.waitFor(() => expect(fallback.streams).toHaveLength(4));
    await sim.reached("stt", 3);
    expect(sim.attempts.stt).toBe(3);
    const finals = await Promise.all(sessions.map(session => session.utter()));
    expect(finals.map(final => final.text === SIM_STT_TEXT).filter(Boolean)).toHaveLength(1);
    expect(changes.at(-1)).toBe("sarvam-stt:closed");
    for (const session of sessions) await session.stream.close();
  });

  it("a stream Sarvam drops mid-call is not replayed, and the reconnect that follows is not sent back into the outage twice", async () => {
    const { fallback, open, call } = setup();
    const live = open();
    expect((await live.utter()).text).toBe(SIM_STT_TEXT);
    sim.mode = "unavailable"; sim.dropAll();
    await vi.waitFor(() => expect(live.events.at(-1)?.type).toBe("closed"));
    expect(live.events.at(-2)).toMatchObject({ type: "error", retryable: true });
    expect(fallback.streams).toHaveLength(0); // a final was already acted on: no replay
    expect(await call()).toBe("fallback"); // the session's reconnect: second failure, circuit opens
    expect(changes).toEqual(["sarvam-stt:open"]);
    expect(await call()).toBe("fallback");
    expect(sim.attempts.stt).toBe(2);
  });

  it("a rejected credential is surfaced, never recognised by the fallback, never an outage", async () => {
    const { fallback, open, call } = setup();
    sim.mode = "unauthorized";
    for (let i = 0; i < 3; i++) {
      const rejected = open();
      await vi.waitFor(() => expect(rejected.events.map(event => event.type)).toEqual(["error", "closed"]));
      expect(rejected.events[0]).toMatchObject({ code: "auth", retryable: false });
    }
    expect(fallback.streams).toHaveLength(0);
    expect(changes).toEqual([]);
    sim.mode = "healthy";
    expect(await call()).toBe("sarvam");
    expect(sim.attempts.stt).toBe(4);
  });
});
