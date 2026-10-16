import { describe, expect, it } from "vitest";
import { TELUGU_PACK } from "@halo/language/language-pack";
import { FallbackSttProvider } from "@halo/providers/voice-vendors/fallback-stt-provider";
import { LocalSttProvider } from "@halo/providers/voice-vendors/local-stt-provider";
import { SarvamSttProvider } from "@halo/providers/voice-vendors/sarvam-stt-provider";
import { parseQualificationSchema } from "@halo/qualification/schema";
import { QualificationSystemActionProvider } from "@halo/qualification/system-action";
import { emptyConversationState } from "@halo/runtime/conversation-state";
import { emptySnapshot } from "@halo/qualification/engine";
import type { SttEvent } from "@halo/ports/streaming-stt-provider";
import { ARUNODHAYA_QUALIFICATION } from "@/content/tenants/arunodhaya/qualification";
import { StandInSpeechEngine } from "../../mocks/local-speech";
import { BUSINESS_A, makeTrusted } from "../../mocks/runtime-fakes";

/**
 * What protects a misheard value when the recognizer reports no confidence.
 *
 * HALO's confidence-gated read-back (system-action.ts, below 0.6) needs a
 * number from the recognizer. Neither real recognizer supplies one — Sarvam's
 * realtime endpoint has none and the local model has none — so on a real call
 * that path cannot fire, on the primary or on the fallback. These tests pin
 * what is left: the fields the tenant schema marks `confirm: true`.
 */

const parsed = parseQualificationSchema(ARUNODHAYA_QUALIFICATION);
if (!parsed.ok) throw new Error("Arunodhaya qualification schema did not parse");
const schema = parsed.schema;

function qualification(sttConfidence: number | null) {
  return new QualificationSystemActionProvider({ schema, pack: TELUGU_PACK, signals: () => ({ sttConfidence }) });
}
const input = (userMessage: string) => ({ trusted: makeTrusted(), business: BUSINESS_A, history: [], userMessage, state: emptyConversationState(), now: new Date("2026-10-13T10:00:00Z") });

describe("read-back when the recognizer reports no confidence", () => {
  it("no real recognizer, alone or as a fallback chain, reports transcript confidence", async () => {
    const sarvam = new SarvamSttProvider({ apiKey: "unused", model: "synthetic-stt-model", connect: () => ({ send() {}, close() {} }) });
    const local = new LocalSttProvider(new StandInSpeechEngine());
    for (const provider of [sarvam, local, new FallbackSttProvider([sarvam, local])]) expect(provider.capabilities().reportsConfidence).toBe(false);

    const events: SttEvent[] = [];
    const stream = local.open({ language: "te-IN", alternativeLanguages: [], format: { encoding: "pcm16le", sampleRate: 8000, channels: 1 }, interimResults: false, phraseHints: [] }, event => events.push(event));
    stream.write(new Uint8Array(8_000).fill(40)); stream.finalize();
    await expect.poll(() => events.find(event => event.type === "final")).toMatchObject({ confidence: null });
    await stream.close();
  });

  it("a name heard with no confidence is stored without being read back; the same name with a low confidence would be", async () => {
    const unknown = qualification(null), low = qualification(0.3);
    for (const provider of [unknown, low]) { await provider.prepare(input("హలో")); await provider.prepare(input("నా పేరు రవి")); }
    expect(unknown.current().fields.name).toMatchObject({ confirmed: false });
    expect(unknown.current().awaitingConfirmationFieldId).toBeNull();
    expect(low.current().awaitingConfirmationFieldId).toBe("name");
  });

  it("the explicitly confirmed phone field is read back even when STT confidence is null", async () => {
    const provider = qualification(null);
    const before = emptySnapshot();
    before.pendingFieldId = "phone";
    provider.restore(before);
    await provider.prepare(input("9876543210"));
    expect(provider.current().fields.phone).toMatchObject({ value: "+919876543210", confirmed: false });
    expect(provider.current().awaitingConfirmationFieldId).toBe("phone");
  });

  it("only the bill and the phone number are read back whatever the recognizer says", () => {
    expect(schema.fields.filter(field => field.confirm).map(field => field.id)).toEqual(["monthly_bill", "phone"]);
  });
});
